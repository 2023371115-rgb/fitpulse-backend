const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

async function genImageThumb(filePath, outDir, width = 400){
  if(!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(outDir, `${base}-thumb.jpg`);
  await sharp(filePath).resize(width).jpeg({ quality: 75 }).toFile(outPath);
  return outPath;
}

module.exports = { genImageThumb };
