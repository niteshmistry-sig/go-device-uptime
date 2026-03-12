#!/usr/bin/env node

/**
 * build.js — Copies src/index.html and images into docs/ for GitHub Pages deployment.
 *
 * Usage: node build.js
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src");
const DOCS = path.join(__dirname, "docs");

// Ensure docs directories exist
if (!fs.existsSync(DOCS)) {
    fs.mkdirSync(DOCS, { recursive: true });
}

// Read and write the HTML (already a single file with inline CSS/JS)
let html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
fs.writeFileSync(path.join(DOCS, "index.html"), html, "utf8");

// Copy icon
const iconSrc = path.join(SRC, "images", "icon.svg");
const iconDest = path.join(DOCS, "images", "icon.svg");
const imagesDir = path.join(DOCS, "images");
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
}
if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, iconDest);
}

console.log("Build complete: docs/index.html (" + Math.round(fs.statSync(path.join(DOCS, "index.html")).size / 1024) + " KB)");
