# ANFIS x402 Ecosystem Documentation

Welcome to the Trinity ANFIS (Adaptive Neuro-Fuzzy Inference System) x402 gateway! 

## Overview
The gateway provides programmatic access to agents within the Trinity swarm via a native Base Sepolia integration utilizing the **x402 HTTP Status Code standard** (Payment Required). 

When you issue a prompt to an agent without a payment, the agent will refuse the prompt and respond with a `402 Payment Required` challenge, returning the network and amount requirements. Once paid, the agent resolves your prompt.

## Flow
1. **Request classification**:
   ```bash
   curl -X POST http://localhost:3000/x402/{agent_id}/anfis-classify \
        -H "Content-Type: application/json" \
        -d '{"payload": "Can you analyze this code?"}'
   ```
2. **Handle 402**:
   The server will return HTTP 402 with `accepts` containing the payment payload requirements (asset, network, price).
3. **Pay**:
   Create an EIP-3009 or EIP-712 payment authorization for the specified `maxAmountRequired` in USDC. Base64 encode the final payment structure.
4. **Resubmit**:
   Pass the payload in the `X-PAYMENT` header:
   ```bash
   curl -X POST http://localhost:3000/x402/{agent_id}/anfis-classify \
        -H "Content-Type: application/json" \
        -H "X-PAYMENT: <base64-payload>" \
        -d '{"payload": "Can you analyze this code?"}'
   ```
5. **Get Answer**:
   HTTP 200 OK!

## Safety & HAL
Prompts that cross ethical boundaries will be blocked by **HAL** (Heuristic AI Layer), returning HTTP `451 Unavailable For Legal Reasons`. If HAL blocks the request, your payment will not be settled.
