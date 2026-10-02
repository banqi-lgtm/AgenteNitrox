const token = 'EAA5oc1QOZB5gBSn5ZAcyZALvcZAVWL9jxN0LAkZB0uj3SziUNv4KE7yYaPG5pVYO4CJEwfOAZAakGntZCefZCxSUS90p5GohS8X4gMiRDu1i7bpmYkBGAKR2XZCUK6fZChgv1YUoZBYgFjAZBf9WUa8mPtjvWg0ZChZA0UIru261Qj9x4zEX0nUFGEDqTZAOBWry6esEQZDZD';
const phoneId = '1217186421467657';

async function checkPhone() {
  const res = await fetch('https://graph.facebook.com/v21.0/' + phoneId + '?fields=verified_name,display_phone_number,quality_rating,code_verification_status,status,throughput', {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  console.log('Phone details:', await res.json());
}
checkPhone();
