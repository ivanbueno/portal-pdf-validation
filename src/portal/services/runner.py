"""Process-isolated adaptation of pdf-api's veraPDF runner."""

import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from .report_parser import parse_verapdf_xml


class ValidationError(Exception):
    pass


def run_profile(path, profile, settings):
    args = [
        settings.java,
        "-Xmx2048m",
        "-Djava.awt.headless=true",
        "-jar",
        str(settings.verapdf_jar),
        "--format",
        "xml",
        "--maxfailuresdisplayed",
        "-1",
    ]
    args += ["--flavour", "ua1"] if profile == "pdfua-1" else ["--profile", str(settings.profile_path)]
    args += ["--extract", "page"]
    args += [str(path)]
    start = time.monotonic()
    with tempfile.TemporaryDirectory() as folder:
        output, errors = Path(folder) / "report.xml", Path(folder) / "stderr"
        with output.open("wb") as out, errors.open("wb") as err:
            try:
                process = subprocess.Popen(args, stdout=out, stderr=err, start_new_session=True)
            except OSError:
                raise ValidationError("Validation engine unavailable")
            try:
                while process.poll() is None:
                    if time.monotonic() - start > settings.profile_timeout:
                        raise ValidationError("Validation timed out")
                    if output.stat().st_size + errors.stat().st_size > settings.report_limit:
                        raise ValidationError("Validation report exceeded the output limit")
                    time.sleep(0.05)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        if output.stat().st_size + errors.stat().st_size > settings.report_limit:
            raise ValidationError("Validation report exceeded the output limit")
        raw = output.read_bytes()
        try:
            parsed = parse_verapdf_xml(raw.decode("utf-8"), int((time.monotonic() - start) * 1000))
        except Exception:
            raise ValidationError("PDF could not be validated; it may be malformed or encrypted")
        return {
            "profile": profile,
            "status": "passed" if parsed.passed else "failed",
            "passed": parsed.passed,
            "summary": parsed.summary.model_dump(),
            "issues": [i.model_dump() for i in parsed.issues],
            "page_count": parsed.page_count,
        }, raw
