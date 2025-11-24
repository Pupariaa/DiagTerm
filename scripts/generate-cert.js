const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const certDir = path.join(__dirname, '../certificates');
const certPath = path.join(certDir, 'diagterm-cert.pfx');
const certKeyPath = path.join(certDir, 'diagterm-cert.key');
const certCrtPath = path.join(certDir, 'diagterm-cert.crt');

if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
    console.log('Created certificates directory');
}

if (fs.existsSync(certPath)) {
    console.log('⚠ Certificate already exists:', certPath);
    console.log('   Delete it first if you want to regenerate.');
    process.exit(0);
}

console.log('Generating self-signed code signing certificate...');
console.log('This may take a few moments...\n');

try {
    const opensslCommand = `openssl req -x509 -newkey rsa:4096 -keyout "${certKeyPath}" -out "${certCrtPath}" -days 3650 -nodes -subj "/CN=Techalchemy/O=Techalchemy/C=FR"`;
    
    execSync(opensslCommand, { stdio: 'inherit' });
    
    console.log('\nConverting to PFX format...');
    const pfxCommand = `openssl pkcs12 -export -out "${certPath}" -inkey "${certKeyPath}" -in "${certCrtPath}" -password pass:diagterm123 -name "DiagTerm Code Signing"`;
    
    execSync(pfxCommand, { stdio: 'inherit' });
    
    fs.unlinkSync(certKeyPath);
    fs.unlinkSync(certCrtPath);
    
    console.log('\n✓ Self-signed certificate generated successfully!');
    console.log(`  Certificate: ${certPath}`);
    console.log('  Password: diagterm123');
    console.log('\n⚠ IMPORTANT:');
    console.log('   - This is a self-signed certificate');
    console.log('   - Windows will show a security warning');
    console.log('   - Users will need to click "More info" then "Run anyway"');
    console.log('   - For production, consider purchasing a trusted certificate');
    
} catch (error) {
    console.error('\n✗ Error generating certificate:', error.message);
    console.error('\nMake sure OpenSSL is installed and available in your PATH.');
    console.error('You can download it from: https://slproweb.com/products/Win32OpenSSL.html');
    process.exit(1);
}

