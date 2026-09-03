package api

import (
	"sync"
	"time"
)

var linkFlows = struct {
	sync.Mutex
	m map[string]linkFlow
}{m: map[string]linkFlow{}}

type linkFlow struct {
	userID  int64
	expires time.Time
}

func rememberLinkFlow(kind, token string, userID int64) {
	linkFlows.Lock()
	defer linkFlows.Unlock()
	now := time.Now()
	for key, flow := range linkFlows.m {
		if now.After(flow.expires) {
			delete(linkFlows.m, key)
		}
	}
	linkFlows.m[kind+":"+token] = linkFlow{userID: userID, expires: now.Add(10 * time.Minute)}
}

func ownsLinkFlow(kind, token string, userID int64) bool {
	linkFlows.Lock()
	defer linkFlows.Unlock()
	flow, ok := linkFlows.m[kind+":"+token]
	return ok && flow.userID == userID && time.Now().Before(flow.expires)
}

func forgetLinkFlow(kind, token string) {
	linkFlows.Lock()
	delete(linkFlows.m, kind+":"+token)
	linkFlows.Unlock()
}
