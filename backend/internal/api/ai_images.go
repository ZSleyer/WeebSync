package api

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/jpeg"
	_ "image/png" // decoded, never written
	"strings"
)

// A picture the user attaches goes to the vision model as pixels and nothing
// else. It is decoded here and written out again as a plain JPEG, so whatever
// rode along in the file - metadata, a second image after the end marker, a
// container the model's provider might read differently than we do - never
// leaves the house. Text painted into the picture still reaches the model;
// the system prompt says what that text is.

const aiImageMaxSide = 1600

// aiCleanImage returns the re-encoded data URL, or "" when the input is not
// a JPEG or PNG the standard library can decode.
func aiCleanImage(dataURL string) string {
	i := strings.Index(dataURL, ";base64,")
	if !strings.HasPrefix(dataURL, "data:image/") || i < 0 {
		return ""
	}
	raw, err := base64.StdEncoding.DecodeString(dataURL[i+len(";base64,"):])
	if err != nil {
		return ""
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width > aiImageMaxSide*4 || cfg.Height > aiImageMaxSide*4 {
		return ""
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return ""
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: 85}); err != nil {
		return ""
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(out.Bytes())
}
