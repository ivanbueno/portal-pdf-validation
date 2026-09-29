# Using the portal

[← Back to overview](../README.md)

The portal is where staff upload PDFs, follow validation progress and read results. Sign in with your Microsoft Entra ID work account; you need the `Validation.User` role. Until you are signed in, the portal shows a sign-in card over a blurred, inactive workspace that holds no document data.

![The portal workspace: upload area, workspace totals and the list of checked files](images/dropzone.png)

## Validate PDFs

1. Drop PDFs onto the upload area, or choose files from your computer.
2. Optionally open **Run options** to choose the standards: WCAG 2.2 (selected by default), PDF/UA-1, or both.
3. Select **Validate PDFs**. Each file is uploaded, checked and queued on its own, so one failed upload doesn't hold up the rest.

The totals at the top show files processed, how many passed each standard, and pages processed.

## Read the results

![An expanded result: WCAG 2.2 passes, PDF/UA-1 fails with one issue, grouped by clause](images/result-details.png)

- **Filename** opens the submitted PDF in a new tab.
- Each row shows the submission date, page count, and a separate outcome and error count for PDF/UA-1 and WCAG.
- **Expand the chevron** to see issues consolidated by specification, clause and test, with profile badges and the location of each failed check.
- The **download button** saves the full JSON report. Its dropdown offers per-standard XML reports, details, and deletion.

Page counts come from [veraPDF page feature extraction](https://docs.verapdf.org/cli/feature-extraction/), within the same time and output limits as validation. Older reports without page data show “Page count unavailable.”

## Limits and retention

| Limit | Value |
|---|---|
| Files per upload | 200 files and 2 GiB per portal selection |
| File size | 200 MiB per file |
| Upload reservation | Expires after one hour if the file isn't submitted |
| Retention | Submitted files and reports become inaccessible after 72 hours |
| Deletion | You can delete a document and its reports at any time |

Cleanup runs every two minutes in Azure (every 30 seconds locally).

> [!IMPORTANT]
> Automated checks do not establish full accessibility or WCAG conformance. Manual review is required. This service does not remediate documents.
