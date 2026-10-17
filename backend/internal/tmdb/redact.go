package tmdb

import (
	"errors"
	"net/http"
	"net/url"
)

// do sends req. net/http puts the full request URL into a transport error,
// and the v3 API key travels in that URL, so the secret query parameters are
// blanked before the error can reach a log or a response.
func (c *Client) do(req *http.Request) (*http.Response, error) {
	resp, err := c.HTTP.Do(req)
	var ue *url.Error
	if errors.As(err, &ue) {
		ue.URL = redactURL(ue.URL)
	}
	return resp, err
}

func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(unparsable URL)"
	}
	q := u.Query()
	for _, k := range []string{"api_key", "session_id"} {
		if q.Has(k) {
			q.Set(k, "REDACTED")
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}
