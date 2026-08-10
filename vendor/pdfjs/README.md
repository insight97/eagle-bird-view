# Vendored PDF.js runtime

This directory contains the minified generic PDF.js 3.11.174 runtime and its
worker, CMaps, and standard-font data. The files came from the `pdfjs-dist`
3.11.174 package and are kept local because Bird View is a classic-script Eagle
Window Plugin with no runtime package loader.

Do not mix versions of `pdf.min.js`, `pdf.worker.min.js`, CMaps, or standard
fonts. Re-run the Eagle runtime probe after changing this directory.

Upstream: https://github.com/mozilla/pdf.js/releases/tag/v3.11.174
License: see `LICENSE` and the license files in the data directories.
