async function test() {
  const res = await fetch('https://zkp-postcard-production.up.railway.app/zkp/repid-proof', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: '51e8367b-a953-4361-a7b0-bb68e494c1bb',
      score: 10000
    })
  });
  console.log('Status:', res.status);
  const data = await res.json();
  console.log('Data:', data);
}
test();
