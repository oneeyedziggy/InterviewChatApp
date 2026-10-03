package server

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

type HTTPStats struct {
	RequestsTotal        int64 `json:"requestsTotal"`
	RequestsInFlight     int64 `json:"requestsInFlight"`
	PeakRequestsInFlight int64 `json:"peakRequestsInFlight"`
	ResponseBytes        int64 `json:"responseBytes"`
	Responses1xx         int64 `json:"responses1xx"`
	Responses2xx         int64 `json:"responses2xx"`
	Responses3xx         int64 `json:"responses3xx"`
	Responses4xx         int64 `json:"responses4xx"`
	Responses5xx         int64 `json:"responses5xx"`
	Panics               int64 `json:"panics"`
}

type httpCounters struct {
	requestsTotal        atomic.Int64
	requestsInFlight     atomic.Int64
	peakRequestsInFlight atomic.Int64
	responseBytes        atomic.Int64
	responses1xx         atomic.Int64
	responses2xx         atomic.Int64
	responses3xx         atomic.Int64
	responses4xx         atomic.Int64
	responses5xx         atomic.Int64
	panics               atomic.Int64
}

func (c *httpCounters) snapshot() HTTPStats {
	return HTTPStats{
		RequestsTotal:        c.requestsTotal.Load(),
		RequestsInFlight:     c.requestsInFlight.Load(),
		PeakRequestsInFlight: c.peakRequestsInFlight.Load(),
		ResponseBytes:        c.responseBytes.Load(),
		Responses1xx:         c.responses1xx.Load(),
		Responses2xx:         c.responses2xx.Load(),
		Responses3xx:         c.responses3xx.Load(),
		Responses4xx:         c.responses4xx.Load(),
		Responses5xx:         c.responses5xx.Load(),
		Panics:               c.panics.Load(),
	}
}

type requestIDContextKey struct{}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func RequestIDFromContext(ctx context.Context) string {
	requestID, _ := ctx.Value(requestIDContextKey{}).(string)
	return requestID
}

func observeHTTP(next http.Handler, counters *httpCounters) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		requestID := r.Header.Get("X-Request-ID")
		if !requestIDPattern.MatchString(requestID) {
			requestID = uuid.NewString()
		}
		w.Header().Set("X-Request-ID", requestID)
		r = r.WithContext(context.WithValue(r.Context(), requestIDContextKey{}, requestID))

		counters.requestsTotal.Add(1)
		inFlight := counters.requestsInFlight.Add(1)
		for {
			peak := counters.peakRequestsInFlight.Load()
			if inFlight <= peak || counters.peakRequestsInFlight.CompareAndSwap(peak, inFlight) {
				break
			}
		}

		observed := &observedResponseWriter{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			if recovered := recover(); recovered != nil {
				counters.panics.Add(1)
				if !observed.hijacked {
					http.Error(observed, "internal server error", http.StatusInternalServerError)
				}
				slog.Error("http_panic", "request_id", requestID, "method", r.Method, "route", boundedRoute(r), "panic", fmt.Sprint(recovered))
			}

			counters.requestsInFlight.Add(-1)
			counters.responseBytes.Add(observed.bytes)
			switch observed.status / 100 {
			case 1:
				counters.responses1xx.Add(1)
			case 2:
				counters.responses2xx.Add(1)
			case 3:
				counters.responses3xx.Add(1)
			case 4:
				counters.responses4xx.Add(1)
			case 5:
				counters.responses5xx.Add(1)
			}
			slog.Info("http_request",
				"request_id", requestID,
				"method", r.Method,
				"route", boundedRoute(r),
				"status", observed.status,
				"response_bytes", observed.bytes,
				"duration_us", time.Since(started).Microseconds(),
			)
		}()

		next.ServeHTTP(observed, r)
	})
}

func boundedRoute(r *http.Request) string {
	if r.Pattern != "" {
		return r.Pattern
	}
	return "unmatched"
}

type observedResponseWriter struct {
	http.ResponseWriter
	status      int
	bytes       int64
	wroteHeader bool
	hijacked    bool
}

func (w *observedResponseWriter) WriteHeader(status int) {
	if w.hijacked || w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *observedResponseWriter) Write(data []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	written, err := w.ResponseWriter.Write(data)
	w.bytes += int64(written)
	return written, err
}

func (w *observedResponseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *observedResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("response writer does not support hijacking")
	}
	connection, readWriter, err := hijacker.Hijack()
	if err == nil {
		w.hijacked = true
		w.status = http.StatusSwitchingProtocols
		w.wroteHeader = true
	}
	return connection, readWriter, err
}

func (w *observedResponseWriter) Push(target string, options *http.PushOptions) error {
	if pusher, ok := w.ResponseWriter.(http.Pusher); ok {
		return pusher.Push(target, options)
	}
	return http.ErrNotSupported
}

func (w *observedResponseWriter) ReadFrom(reader io.Reader) (int64, error) {
	if readerFrom, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		written, err := readerFrom.ReadFrom(reader)
		w.bytes += written
		return written, err
	}
	return io.Copy(struct{ io.Writer }{w}, reader)
}
