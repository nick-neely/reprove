# verify

Checks the HMAC signature on an inbound webhook body.

The sender hex-encodes the digest (lower-case), so comparing hex strings
rather than raw bytes is the documented wire format, not an oversight.
