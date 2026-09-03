package auth

import "testing"

func TestHashVerify(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword("correct horse battery", h) {
		t.Error("correct password rejected")
	}
	if VerifyPassword("wrong password!!", h) {
		t.Error("wrong password accepted")
	}
	if VerifyPassword("x", "garbage") {
		t.Error("garbage hash accepted")
	}
}

func TestVerifyPasswordRejectsExcessiveCost(t *testing.T) {
	encoded := "$argon2id$v=19$m=4294967295,t=3,p=4$MTIzNDU2Nzg5MGFiY2RlZg$MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY"
	if VerifyPassword("password", encoded) {
		t.Fatal("accepted hash with unsafe memory cost")
	}
}

func TestValidatePassword(t *testing.T) {
	if err := ValidatePassword("short"); err == nil {
		t.Error("short password accepted")
	}
	if err := ValidatePassword("long enough password"); err != nil {
		t.Error("valid password rejected")
	}
}
