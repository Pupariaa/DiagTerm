const fs = require('fs');
const path = require('path');

const certDir = path.join(__dirname, '../certificates');
const defaultCertPath = path.join(certDir, 'diagterm-cert.pfx');
const defaultPassword = 'diagterm123';

function setupCertificate() {
    const certificateFile = process.env.CSC_LINK || process.env.WIN_CERTIFICATE_FILE || defaultCertPath;
    const certificatePassword = process.env.CSC_KEY_PASSWORD || process.env.WIN_CERTIFICATE_PASSWORD || defaultPassword;

    if (!fs.existsSync(certificateFile)) {
        if (certificateFile === defaultCertPath) {
            console.warn('⚠ Self-signed certificate not found.');
            console.warn(`   Expected location: ${certificateFile}`);
            console.warn('   Run: node scripts/generate-cert.js');
            console.warn('   Or set CSC_LINK environment variable to your certificate path.');
            return false;
        } else {
            console.error(`✗ Certificate file not found: ${certificateFile}`);
            console.error('   Please check the CSC_LINK or WIN_CERTIFICATE_FILE environment variable.');
            return false;
        }
    }

    console.log('✓ Code signing certificate found');
    console.log(`  Certificate: ${path.basename(certificateFile)}`);

    process.env.CSC_LINK = certificateFile;
    process.env.CSC_KEY_PASSWORD = certificatePassword;
    return true;
}

if (require.main === module) {
    setupCertificate();
} else {
    module.exports = setupCertificate;
}

