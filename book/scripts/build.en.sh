#!/bin/bash
set -e

asciidoctor -o output/en/book.html ./en/book.adoc
asciidoctor-pdf \
  -a pdf-theme=./theme/orstyle-theme.yml \
  -a pdf-fontsdir=./theme/fonts \
  -o output/en/book.pdf ./en/book.adoc
asciidoctor-epub3 -o output/en/book.epub ./en/book.adoc

echo "✅ Build complete: output/en/{book.html, book.pdf, book.epub}"
