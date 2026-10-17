# Patched copy of github.com/nwaples/rardecode/v2

Vendored from upstream v2.4.5 (WeebSync used v2.4.3 before) and wired in
with a `replace` directive in `backend/go.mod`. Upstream v2.4.5, the latest, does
not fix any of the three bugs below. Drop this directory once upstream does.

Dependabot cannot update this copy (the module is replaced, and the gomod
entry ignores it). Diff new upstream releases by hand and re-apply the patches.

Patches, all small:

1. `decode20.go`: a new (non-solid) file now clears the LZ offset history and
   the last length, as unrar does in `UnpInitData20`. Before, it inherited the
   previous file's distances.
2. `decode29.go` `parseVMFilter`: the filter block length was appended to the
   length history twice for a new filter, so later filters read another
   filter's length.
3. `decode_reader.go`: RAR 7.0 files run on the 5.0 decoder, but the version
   check compared 5.0 with 7.0 and refused the second file of every RAR 7.0
   archive with `ErrMultipleDecoders`.

Regression tests: `patches_test.go` here (run with
`cd backend/third_party/rardecode && go test`, it is a separate module) and
`backend/internal/api/unpack_rar_test.go`.

---

# rardecode
[![Go Reference](https://pkg.go.dev/badge/github.com/nwaples/rardecode/v2.svg)](https://pkg.go.dev/github.com/nwaples/rardecode/v2)
[![Go Report Card](https://goreportcard.com/badge/github.com/nwaples/rardecode/v2)](https://goreportcard.com/report/github.com/nwaples/rardecode/v2)

A go package for reading RAR archives.
