package server

import "testing"

func TestBuildSignedRequestInputMatchesClientVector(t *testing.T) {
	auth := socketMutationAuth{
		Version:   "v1",
		Event:     "clientMessage",
		UserID:    "user-a",
		SessionID: "session-a",
		Timestamp: 1234567890,
		Nonce:     "nonce-id",
		Claims: map[string]string{
			"b": "true",
			"a": "42",
			"c": `{"nested":"value"}`,
		},
	}
	want := "v1|clientMessage|user-a|session-a|1234567890|nonce-id|a=NDI&b=dHJ1ZQ&c=eyJuZXN0ZWQiOiJ2YWx1ZSJ9"
	if got := buildSignedRequestInput(auth); got != want {
		t.Fatalf("signed request input = %q, want %q", got, want)
	}
}
