# Third-party attribution

- The XML report parser and response types are adapted from `pdf-api/pdf_accessibility_validator`, copyright (c) 2026 PDF Accessibility Validator, MIT. Full notice: `pdf-api-MIT.txt`. The runner preserves the same CLI/report approach, adding process and resource limits.
- `profiles/WCAG-2-2-Complete.xml` is copied byte-for-byte from the user's `pdf-remediation/resources/configuration/WCAG-2-2-Complete.xml`, the profile source referenced by pdf-api's Dockerfile. Its embedded creator is the veraPDF Consortium. Source: https://github.com/ivanbueno-jcc/pdf-remediation/blob/main/resources/configuration/WCAG-2-2-Complete.xml . This is the Complete profile, not the JCC variant.
- Portal layout and interaction patterns reference the user's `pdf-remediation/src/pdf_web`. The new frontend is independently implemented for validation.
- veraPDF 1.30.2 is distributed separately in the container from its official installer. It is dual licensed under GPLv3+ / MPLv2+; use under MPLv2+. Its installer preserves upstream license materials under `/opt/verapdf`. Source: https://github.com/veraPDF/veraPDF-library and https://github.com/veraPDF/veraPDF-apps . Installer SHA-256: `6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838`.
- `tests/fixtures/ua-pass.pdf` and `ua-fail.pdf` are unmodified veraPDF Consortium corpus files `PDF_UA-1/5 Version identification/5-t01-pass-a.pdf` and `5-t01-fail-a.pdf`. Source: https://github.com/veraPDF/veraPDF-corpus . Licensed CC BY 4.0: https://creativecommons.org/licenses/by/4.0/ . The failing fixture intentionally lacks the PDF/UA identification claim, while passing the custom WCAG profile.
- `sample_verapdf_output.xml` is from the MIT-licensed pdf-api tests.
- `tests/fixtures/encrypted.pdf` is a CC BY 4.0 derivative of `ua-pass.pdf`, encrypted using pypdf solely to test password-protected input handling. Password: `test-only-password`. Content authorship remains veraPDF Consortium.

Vendored custom profile SHA-256: `f2b45bb4db6f034df97cdd227582102b6f48171973917e91a0ac6029a68285e8`.
