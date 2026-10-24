package api

import (
	"encoding/json"
	"os"
	"testing"
)

// swag attaches an annotation block to the declaration that follows it: the
// settings GET block once sat above a type, so the spec had no GET operation.
func TestSwaggerSettingsHasGetAndPut(t *testing.T) {
	raw, err := os.ReadFile("../../docs/swagger.json")
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"get", "put"} {
		if _, ok := spec.Paths["/api/settings"][method]; !ok {
			t.Errorf("docs/swagger.json has no %s operation for /api/settings", method)
		}
	}
}
