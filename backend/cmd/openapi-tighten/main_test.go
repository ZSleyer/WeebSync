package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

func TestPointerElems(t *testing.T) {
	for src, want := range map[string]string{
		"[]*int":          "items",
		"map[string]*int": "additionalProperties",
		"[]int":           "",
		"map[string]int":  "",
	} {
		expr, err := parser.ParseExpr(src)
		if err != nil {
			t.Fatal(err)
		}
		if got := pointerElems(expr); got != want {
			t.Errorf("%s: got %q, want %q", src, got, want)
		}
	}
}

func TestJSONFields(t *testing.T) {
	src := `package p
type Base struct {
	ID int ` + "`json:\"id\"`" + `
}
type Extra struct {
	Note string ` + "`json:\"note\"`" + `
}
type T struct {
	Base
	*Extra
	Name   string  ` + "`json:\"name\"`" + ` // shown in lists
	Tag    string  ` + "`json:\"tag,omitempty\"`" + `
	Next   *int    ` + "`json:\"next\"`" + `
	Maybe  *int    ` + "`json:\"maybe,omitempty\"`" + `
	Hidden string  ` + "`json:\"-\"`" + `
	Plain  bool
	inner  int
}`
	file, err := parser.ParseFile(token.NewFileSet(), "p.go", src, parser.ParseComments)
	if err != nil {
		t.Fatal(err)
	}
	types := pkgTypes{"p": {}}
	for _, d := range file.Decls {
		for _, s := range d.(*ast.GenDecl).Specs {
			ts := s.(*ast.TypeSpec)
			types["p"][ts.Name.Name] = ts.Type.(*ast.StructType)
		}
	}

	want := []field{
		{name: "id"},
		{name: "note", optional: true},
		{name: "name"},
		{name: "tag", optional: true},
		{name: "next", nullable: true},
		{name: "maybe", optional: true},
		{name: "Plain"},
	}
	got := jsonFields("p", types["p"]["T"], types, false)
	if len(got) != len(want) {
		t.Fatalf("got %d fields, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		g := got[i]
		if g.name != w.name || g.optional != w.optional || g.nullable != w.nullable {
			t.Errorf("field %d: got %s optional=%v nullable=%v, want %+v", i, g.name, g.optional, g.nullable, w)
		}
	}
	if got[2].comment != "shown in lists" {
		t.Errorf("name comment: got %q", got[2].comment)
	}
}
