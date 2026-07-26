// Gera PNGs a partir dos SVGs. Rode uma vez: `node icons/gen-icons.js`
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const any = fs.readFileSync(path.join(dir, 'icon.svg'));
const mask = fs.readFileSync(path.join(dir, 'icon-maskable.svg'));

const jobs = [
  { svg: any,  size: 192, out: 'icon-192.png' },
  { svg: any,  size: 512, out: 'icon-512.png' },
  { svg: any,  size: 180, out: 'apple-touch-icon.png' },
  { svg: mask, size: 192, out: 'icon-maskable-192.png' },
  { svg: mask, size: 512, out: 'icon-maskable-512.png' },
];

(async () => {
  for (const j of jobs) {
    await sharp(j.svg).resize(j.size, j.size).png().toFile(path.join(dir, j.out));
    console.log('->', j.out);
  }
})();
