"""Process-isolated adaptation of pdf-api's veraPDF runner."""

import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from ..config import PROFILES, Status, outcome
from .report_parser import parse_verapdf_xml


class ValidationError(Exception):
    pass


def profile_error(profile, error):
    """The result for a profile that could not be validated; other profiles are unaffected."""
    return {"profile": profile, "status": Status.ERROR, "passed": None, "error": str(error), "issues": []}


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
    flavour = PROFILES[profile].flavour
    args += ["--flavour", flavour] if flavour else ["--profile", str(settings.profile_path)]
    args += ["--extract", "page"]
    args += [str(path)]
    start = time.monotonic()
    with tempfile.TemporaryDirectory() as folder:
        output, errors = Path(folder) / "report.xml", Path(folder) / "stderr"

        def check_output_size():
            if output.stat().st_size + errors.stat().st_size > settings.report_limit:
                raise ValidationError("Validation report exceeded the output limit")

        with output.open("wb") as out, errors.open("wb") as err:
            try:
                process = subprocess.Popen(args, stdout=out, stderr=err, start_new_session=True)
            except OSError:
                raise ValidationError("Validation engine unavailable")
            try:
                while process.poll() is None:
                    if time.monotonic() - start > settings.profile_timeout:
                        raise ValidationError("Validation timed out")
                    check_output_size()
                    time.sleep(0.05)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        check_output_size()
        raw = output.read_bytes()
        try:
            parsed = parse_verapdf_xml(raw, int((time.monotonic() - start) * 1000))
        except Exception:
            raise ValidationError("PDF could not be validated; it may be malformed or encrypted")
        return {
            "profile": profile,
            "status": outcome(parsed.passed),
            "passed": parsed.passed,
            "summary": parsed.summary.model_dump(),
            "issues": [i.model_dump() for i in parsed.issues],
            "page_count": parsed.page_count,
        }, raw
