#!/bin/bash
set -e

asciidoctor -o output/vi/book.html ./vi/book.adoc
asciidoctor-pdf \
  -a pdf-theme=./theme/orstyle-theme.yml \
  -a pdf-fontsdir=./theme/fonts \
  -o output/vi/book.pdf ./vi/book.adoc
asciidoctor-epub3 -o output/vi/book.epub ./vi/book.adoc

echo "✅ Build complete: output/vi/{book.html, book.pdf, book.epub}"
