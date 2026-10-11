// Command openapi-tighten adds what swag leaves out of docs/swagger.json: which
// properties are always present and which can be null. swag marks nothing as
// required and knows no null, so a TypeScript client generated from its output
// would type every field as optional and never as null.
//
// Both facts come from the Go structs the schemas are named after: a field
// without omitempty is always encoded (required), a pointer field without
// omitempty is encoded as null when nil (nullable). Fields reached through an
// embedded pointer are not required, a nil embed drops them.
//
// It fails when a schema cannot be matched to exactly one struct or when the
// schema's properties differ from the struct's json fields, so a drift between
// swag and this tool shows up in gen-docs.sh rather than in the frontend.
//
// Usage (from backend/, after swag):
//
//	go run ./cmd/openapi-tighten docs/swagger.json
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
)

// field is one json property of a struct, embeds already flattened.
type field struct {
	name     string
	typ      ast.Expr // pointer stripped
	optional bool     // omitempty, or reached through an embedded pointer
	nullable bool     // pointer without omitempty
	comment  string   // doc or line comment, for where swag leaves no description
}

// pkgTypes maps a package name to its named struct types.
type pkgTypes map[string]map[string]*ast.StructType

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: openapi-tighten docs/swagger.json")
	}
	specPath := os.Args[1]

	types, err := parseStructs(".")
	if err != nil {
		log.Fatal(err)
	}

	raw, err := os.ReadFile(specPath)
	if err != nil {
		log.Fatal(err)
	}
	var spec map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&spec); err != nil {
		log.Fatal(err)
	}

	schemas, _ := spec["components"].(map[string]any)["schemas"].(map[string]any)
	var errs []string
	for _, key := range sortedKeys(schemas) {
		schema := schemas[key].(map[string]any)
		if _, ok := schema["properties"]; !ok {
			continue // enums and other non-struct types
		}
		pkg, name, _ := strings.Cut(key, ".")
		st, ok := types[pkg][name]
		if !ok {
			errs = append(errs, fmt.Sprintf("%s: no struct %s in package %s", key, name, pkg))
			continue
		}
		errs = append(errs, tighten(key, schema, pkg, st, types)...)
	}
	if len(errs) > 0 {
		log.Fatalf("openapi-tighten:\n  %s", strings.Join(errs, "\n  "))
	}

	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "    ")
	if err := enc.Encode(spec); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(specPath, out.Bytes(), 0o644); err != nil {
		log.Fatal(err)
	}
}

// tighten sets required and null on one object schema from its struct, and
// recurses into inline (anonymous) struct properties.
func tighten(where string, schema map[string]any, pkg string, st *ast.StructType, types pkgTypes) []string {
	props := schema["properties"].(map[string]any)
	fields := jsonFields(pkg, st, types, false)

	var errs []string
	var want []string
	for _, f := range fields {
		want = append(want, f.name)
	}
	slices.Sort(want)
	if have := sortedKeys(props); !slices.Equal(have, want) {
		return []string{fmt.Sprintf("%s: spec properties %v, struct fields %v", where, have, want)}
	}

	var required []any
	for _, f := range fields {
		if !f.optional {
			required = append(required, f.name)
		}
		prop := props[f.name].(map[string]any)
		if inner := inlineStruct(f.typ); inner != nil {
			target := prop
			if items, ok := prop["items"].(map[string]any); ok {
				target = items
			}
			if _, ok := target["properties"]; ok {
				errs = append(errs, tighten(where+"."+f.name, target, pkg, inner, types)...)
			}
		}
		if _, ok := prop["description"]; !ok && f.comment != "" {
			prop["description"] = f.comment
		}
		// []*T and map[K]*T hold null elements for nil pointers
		if key := pointerElems(f.typ); key != "" {
			if elem, ok := prop[key].(map[string]any); ok {
				prop[key] = withNull(elem)
			}
		}
		if f.nullable {
			props[f.name] = withNull(prop)
		}
	}
	if len(required) > 0 {
		schema["required"] = required
	} else {
		delete(schema, "required")
	}
	return errs
}

// jsonFields lists the properties encoding/json writes for st, in field order.
// ponytail: slices and maps encode nil as null too, but they are typed non-null
// here like the handwritten frontend types always did; mark them nullable if a
// handler turns out to send null lists.
func jsonFields(pkg string, st *ast.StructType, types pkgTypes, viaPtr bool) []field {
	var out []field
	for _, f := range st.Fields.List {
		tag := reflect.StructTag("")
		if f.Tag != nil {
			tag = reflect.StructTag(strings.Trim(f.Tag.Value, "`"))
		}
		jsonTag, hasTag := tag.Lookup("json")
		name, opts, _ := strings.Cut(jsonTag, ",")
		if name == "-" && opts == "" {
			continue
		}
		omit := slices.Contains(strings.Split(opts, ","), "omitempty")

		typ, isPtr := f.Type, false
		if star, ok := typ.(*ast.StarExpr); ok {
			typ, isPtr = star.X, true
		}

		if len(f.Names) == 0 {
			if name == "" { // untagged embed: its fields are promoted
				embPkg, emb := resolve(pkg, typ, types)
				if emb != nil {
					out = append(out, jsonFields(embPkg, emb, types, viaPtr || isPtr)...)
				}
				continue
			}
			f.Names = []*ast.Ident{{Name: exprName(typ)}}
		}
		for _, n := range f.Names {
			if !n.IsExported() {
				continue
			}
			jn := name
			if !hasTag || jn == "" {
				jn = n.Name
			}
			out = append(out, field{
				name:     jn,
				typ:      typ,
				optional: omit || viaPtr,
				nullable: isPtr && !omit,
				comment:  fieldComment(f),
			})
		}
	}
	return out
}

// resolve finds the struct behind an embedded type name, in pkg or, for a
// qualified name, in the package it names.
func resolve(pkg string, typ ast.Expr, types pkgTypes) (string, *ast.StructType) {
	switch t := typ.(type) {
	case *ast.Ident:
		return pkg, types[pkg][t.Name]
	case *ast.SelectorExpr:
		if x, ok := t.X.(*ast.Ident); ok {
			return x.Name, types[x.Name][t.Sel.Name]
		}
	}
	return pkg, nil
}

func exprName(typ ast.Expr) string {
	if sel, ok := typ.(*ast.SelectorExpr); ok {
		return sel.Sel.Name
	}
	if id, ok := typ.(*ast.Ident); ok {
		return id.Name
	}
	return ""
}

// fieldComment is a field's doc comment, else its trailing line comment. swag
// reads neither for a field typed by another schema, nor line comments at all.
func fieldComment(f *ast.Field) string {
	if text := strings.TrimSpace(f.Doc.Text()); text != "" {
		return text
	}
	return strings.TrimSpace(f.Comment.Text())
}

// inlineStruct returns the anonymous struct of a field typed struct{...} or
// []struct{...}.
func inlineStruct(typ ast.Expr) *ast.StructType {
	if arr, ok := typ.(*ast.ArrayType); ok {
		typ = arr.Elt
	}
	if star, ok := typ.(*ast.StarExpr); ok {
		typ = star.X
	}
	st, _ := typ.(*ast.StructType)
	return st
}

// pointerElems names the schema key of a slice's or map's elements when those
// are pointers: "items" or "additionalProperties", else "".
func pointerElems(typ ast.Expr) string {
	switch t := typ.(type) {
	case *ast.ArrayType:
		if _, ok := t.Elt.(*ast.StarExpr); ok {
			return "items"
		}
	case *ast.MapType:
		if _, ok := t.Value.(*ast.StarExpr); ok {
			return "additionalProperties"
		}
	}
	return ""
}

// withNull widens a property schema to also allow null.
func withNull(prop map[string]any) map[string]any {
	if t, ok := prop["type"].(string); ok {
		prop["type"] = []any{t, "null"}
		return prop
	}
	if ref, ok := prop["$ref"]; ok {
		delete(prop, "$ref")
		prop["anyOf"] = []any{map[string]any{"$ref": ref}, map[string]any{"type": "null"}}
		return prop
	}
	return prop
}

// parseStructs collects every named struct type under root, skipping tests
// and cmd/. A package name defined in two directories is an error, the spec
// keys schemas by package name only.
func parseStructs(root string) (pkgTypes, error) {
	types := pkgTypes{}
	dirOf := map[string]string{}
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path == "cmd" || path == "docs" || path == "data" || path == "web" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution|parser.ParseComments)
		if err != nil {
			return err
		}
		pkg, dir := file.Name.Name, filepath.Dir(path)
		if prev, ok := dirOf[pkg]; ok && prev != dir {
			return fmt.Errorf("package name %s used in %s and %s", pkg, prev, dir)
		}
		dirOf[pkg] = dir
		if types[pkg] == nil {
			types[pkg] = map[string]*ast.StructType{}
		}
		for _, decl := range file.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || gd.Tok != token.TYPE {
				continue
			}
			for _, spec := range gd.Specs {
				ts := spec.(*ast.TypeSpec)
				if st, ok := ts.Type.(*ast.StructType); ok {
					types[pkg][ts.Name.Name] = st
				}
			}
		}
		return nil
	})
	return types, err
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
