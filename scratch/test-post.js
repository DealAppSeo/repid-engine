async function test() {
  const res = await fetch('https://zkp-postcard-production.up.railway.app/zkp/repid-proof', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: 'test-agent',
      score: 100
    })
  });
  console.log('Status:', res.status);
  const data = await res.json();
  console.log('Data:', data);
}
test();
