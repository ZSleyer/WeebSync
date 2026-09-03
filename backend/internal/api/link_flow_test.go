package api

import "testing"

func TestLinkFlowIsBoundToUser(t *testing.T) {
	rememberLinkFlow("test", "token", 7)
	if ownsLinkFlow("test", "token", 8) {
		t.Fatal("another user owns the flow")
	}
	if !ownsLinkFlow("test", "token", 7) {
		t.Fatal("initiating user lost the flow")
	}
	forgetLinkFlow("test", "token")
	if ownsLinkFlow("test", "token", 7) {
		t.Fatal("consumed flow still exists")
	}
}
