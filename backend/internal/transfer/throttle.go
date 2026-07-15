package transfer

import (
	"context"
	"io"

	"golang.org/x/time/rate"
)

// throttledReader limits read bandwidth against up to two limiters
// (global + per-download). A nil limiter means unlimited.
type throttledReader struct {
	r        io.Reader
	ctx      context.Context
	limiters []*rate.Limiter
}

func (t *throttledReader) Read(p []byte) (int, error) {
	// cap chunk size so WaitN never exceeds a limiter's burst
	max := len(p)
	for _, l := range t.limiters {
		if l != nil && l.Limit() != rate.Inf {
			if b := l.Burst(); b < max {
				max = b
			}
		}
	}
	if max <= 0 {
		max = 1
	}
	n, err := t.r.Read(p[:max])
	if n > 0 {
		for _, l := range t.limiters {
			if l == nil || l.Limit() == rate.Inf {
				continue
			}
			if werr := l.WaitN(t.ctx, n); werr != nil {
				return n, werr
			}
		}
	}
	return n, err
}

// newLimiter builds a limiter for bytesPerSec; 0 means unlimited (nil).
func newLimiter(bytesPerSec int64) *rate.Limiter {
	if bytesPerSec <= 0 {
		return nil
	}
	// burst = 1s worth of data, min 32KiB so large reads still work
	burst := int(bytesPerSec)
	if burst < 32*1024 {
		burst = 32 * 1024
	}
	return rate.NewLimiter(rate.Limit(bytesPerSec), burst)
}
