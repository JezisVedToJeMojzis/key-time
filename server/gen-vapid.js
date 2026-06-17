// Generates a fresh VAPID key pair for Web Push and prints .env lines.
// Usage: npm run gen-vapid
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();

console.log('\nAdd these to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('\n(Keep the private key secret. The public key is shipped to the browser.)\n');
