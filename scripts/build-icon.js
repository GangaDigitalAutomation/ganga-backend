const fs = require('fs');
const path = require('path');
const pngToIco = require('png-to-ico');

const source = `C:\\Users\\lenovo\\.gemini\\antigravity\\brain\\089dab48-93b0-4796-9940-31cb0ae0844f\\logo_1774332442959.png`;
const destDir = path.join(__dirname, '..', 'assets');
const dest = path.join(destDir, 'logo.ico');

pngToIco(source)
  .then(buf => {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.writeFileSync(dest, buf);
    console.log('Successfully created assets/logo.ico');
  })
  .catch(err => {
    console.error('Error creating icon:', err);
    process.exit(1);
  });
