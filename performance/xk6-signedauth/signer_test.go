package signedauth

import (
	"strings"
	"testing"

	"github.com/ProtonMail/gopenpgp/v2/crypto"
	"github.com/ProtonMail/gopenpgp/v2/helper"
)

func TestCanonicalInputMatchesClientVector(t *testing.T) {
	signer := &Signer{}
	input, err := signer.CanonicalInput(
		"clientMessage",
		"user-a",
		"session-a",
		1234567890,
		"nonce-id",
		map[string]interface{}{
			"b": true,
			"a": float64(42),
			"c": map[string]interface{}{"nested": "value"},
		},
	)
	if err != nil {
		t.Fatalf("CanonicalInput failed: %v", err)
	}
	want := "v1|clientMessage|user-a|session-a|1234567890|nonce-id|a=NDI&b=dHJ1ZQ&c=eyJuZXN0ZWQiOiJ2YWx1ZSJ9"
	if input != want {
		t.Fatalf("canonical input = %q, want %q", input, want)
	}
}

func TestSignProducesVerifiableDetachedSignature(t *testing.T) {
	privateArmored, err := helper.GenerateKey("performance", "performance@invalid", []byte(""), "rsa", 2048)
	if err != nil {
		t.Fatalf("GenerateKey failed: %v", err)
	}
	signer := &Signer{}
	auth, err := signer.Sign(privateArmored, "clientMessage", "user-a", "session-a", map[string]interface{}{"roomId": "room-a"})
	if err != nil {
		t.Fatalf("Sign failed: %v", err)
	}
	if auth["version"] != "v1" || auth["nonce"] == "" || auth["timestamp"] == int64(0) {
		t.Fatalf("incomplete auth envelope: %+v", auth)
	}

	normalizedClaims := auth["claims"].(map[string]string)
	input := buildSigningInput("clientMessage", "user-a", "session-a", auth["timestamp"].(int64), auth["nonce"].(string), normalizedClaims)
	privateKey, err := crypto.NewKeyFromArmored(privateArmored)
	if err != nil {
		t.Fatalf("parse key: %v", err)
	}
	publicKey, err := privateKey.ToPublic()
	if err != nil {
		t.Fatalf("public key: %v", err)
	}
	keyRing, err := crypto.NewKeyRing(publicKey)
	if err != nil {
		t.Fatalf("public key ring: %v", err)
	}
	signature, err := crypto.NewPGPSignatureFromArmored(auth["signature"].(string))
	if err != nil {
		t.Fatalf("parse signature: %v", err)
	}
	if err := keyRing.VerifyDetached(crypto.NewPlainMessageFromString(input), signature, 0); err != nil {
		t.Fatalf("verify signature: %v", err)
	}
	if !strings.Contains(auth["signature"].(string), "BEGIN PGP SIGNATURE") {
		t.Fatal("expected armored detached signature")
	}
}

func TestSignRejectsMissingIdentity(t *testing.T) {
	if _, err := new(Signer).Sign("key", "", "user", "session", nil); err == nil {
		t.Fatal("expected missing event to fail")
	}
}