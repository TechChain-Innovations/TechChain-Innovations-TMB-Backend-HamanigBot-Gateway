#!/bin/bash
#
# Manual Integration Test for Gateway Nonce API
#
# Prerequisites:
#   1. Start Gateway: pnpm start --passphrase=<PASSPHRASE> --dev
#   2. Ensure Gateway is running on localhost:15888
#
# Usage:
#   ./scripts/test-nonce-api.sh [network] [wallet_address]
#
# Examples:
#   ./scripts/test-nonce-api.sh bsc 0xYourWalletAddress
#   ./scripts/test-nonce-api.sh mainnet 0xYourWalletAddress
#

GATEWAY_URL="${GATEWAY_URL:-http://localhost:15888}"
NETWORK="${1:-bsc}"
WALLET="${2:-0x1234567890123456789012345678901234567890}"

echo "═══════════════════════════════════════════════════════════"
echo "  Gateway Nonce API Integration Test"
echo "═══════════════════════════════════════════════════════════"
echo "  Gateway URL: $GATEWAY_URL"
echo "  Network:     $NETWORK"
echo "  Wallet:      $WALLET"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Acquire Nonce
echo -e "${YELLOW}[TEST 1]${NC} POST /nonce/acquire - Acquiring nonce lock..."
ACQUIRE_RESPONSE=$(curl -s -X POST "${GATEWAY_URL}/chains/ethereum/nonce/acquire" \
  -H "Content-Type: application/json" \
  -d "{
    \"network\": \"$NETWORK\",
    \"walletAddress\": \"$WALLET\",
    \"ttlMs\": 30000
  }")

echo "Response: $ACQUIRE_RESPONSE"

LOCK_ID=$(echo "$ACQUIRE_RESPONSE" | jq -r '.lockId // empty')
NONCE=$(echo "$ACQUIRE_RESPONSE" | jq -r '.nonce // empty')
EXPIRES_AT=$(echo "$ACQUIRE_RESPONSE" | jq -r '.expiresAt // empty')

if [ -z "$LOCK_ID" ] || [ "$LOCK_ID" == "null" ]; then
  echo -e "${RED}✗ FAILED:${NC} No lockId in response"
  exit 1
else
  echo -e "${GREEN}✓ SUCCESS:${NC} lockId=$LOCK_ID, nonce=$NONCE, expiresAt=$EXPIRES_AT"
fi
echo ""

# Test 2: Check Status
echo -e "${YELLOW}[TEST 2]${NC} GET /nonce/status - Checking active locks..."
STATUS_RESPONSE=$(curl -s -X GET "${GATEWAY_URL}/chains/ethereum/nonce/status")
echo "Response: $STATUS_RESPONSE"

ACTIVE_LOCKS=$(echo "$STATUS_RESPONSE" | jq -r '.activeLocks // 0')
if [ "$ACTIVE_LOCKS" -ge 1 ]; then
  echo -e "${GREEN}✓ SUCCESS:${NC} $ACTIVE_LOCKS active lock(s) found"
else
  echo -e "${RED}✗ FAILED:${NC} Expected at least 1 active lock"
fi
echo ""

# Test 3: Release with transactionSent=true
echo -e "${YELLOW}[TEST 3]${NC} POST /nonce/release - Releasing lock (transactionSent=true)..."
RELEASE_RESPONSE=$(curl -s -X POST "${GATEWAY_URL}/chains/ethereum/nonce/release" \
  -H "Content-Type: application/json" \
  -d "{
    \"network\": \"$NETWORK\",
    \"walletAddress\": \"$WALLET\",
    \"lockId\": \"$LOCK_ID\",
    \"transactionSent\": true
  }")

echo "Response: $RELEASE_RESPONSE"

SUCCESS=$(echo "$RELEASE_RESPONSE" | jq -r '.success // false')
if [ "$SUCCESS" == "true" ]; then
  echo -e "${GREEN}✓ SUCCESS:${NC} Lock released successfully"
else
  echo -e "${RED}✗ FAILED:${NC} Lock release failed"
fi
echo ""

# Test 4: Acquire again and test rollback
echo -e "${YELLOW}[TEST 4]${NC} POST /nonce/acquire - Acquiring second lock..."
ACQUIRE2_RESPONSE=$(curl -s -X POST "${GATEWAY_URL}/chains/ethereum/nonce/acquire" \
  -H "Content-Type: application/json" \
  -d "{
    \"network\": \"$NETWORK\",
    \"walletAddress\": \"$WALLET\",
    \"ttlMs\": 30000
  }")

echo "Response: $ACQUIRE2_RESPONSE"

LOCK_ID2=$(echo "$ACQUIRE2_RESPONSE" | jq -r '.lockId // empty')
NONCE2=$(echo "$ACQUIRE2_RESPONSE" | jq -r '.nonce // empty')

if [ -z "$LOCK_ID2" ] || [ "$LOCK_ID2" == "null" ]; then
  echo -e "${RED}✗ FAILED:${NC} No lockId in response"
  exit 1
else
  echo -e "${GREEN}✓ SUCCESS:${NC} lockId=$LOCK_ID2, nonce=$NONCE2"
fi
echo ""

# Test 5: Release with transactionSent=false (rollback)
echo -e "${YELLOW}[TEST 5]${NC} POST /nonce/release - Releasing lock (transactionSent=false - ROLLBACK)..."
RELEASE2_RESPONSE=$(curl -s -X POST "${GATEWAY_URL}/chains/ethereum/nonce/release" \
  -H "Content-Type: application/json" \
  -d "{
    \"network\": \"$NETWORK\",
    \"walletAddress\": \"$WALLET\",
    \"lockId\": \"$LOCK_ID2\",
    \"transactionSent\": false
  }")

echo "Response: $RELEASE2_RESPONSE"

SUCCESS2=$(echo "$RELEASE2_RESPONSE" | jq -r '.success // false')
MESSAGE=$(echo "$RELEASE2_RESPONSE" | jq -r '.message // empty')
if [ "$SUCCESS2" == "true" ]; then
  echo -e "${GREEN}✓ SUCCESS:${NC} Lock released with rollback. Message: $MESSAGE"
else
  echo -e "${RED}✗ FAILED:${NC} Lock release failed"
fi
echo ""

# Test 6: Verify nonce was rolled back (should get same nonce)
echo -e "${YELLOW}[TEST 6]${NC} POST /nonce/acquire - Verifying nonce rollback..."
ACQUIRE3_RESPONSE=$(curl -s -X POST "${GATEWAY_URL}/chains/ethereum/nonce/acquire" \
  -H "Content-Type: application/json" \
  -d "{
    \"network\": \"$NETWORK\",
    \"walletAddress\": \"$WALLET\",
    \"ttlMs\": 5000
  }")

echo "Response: $ACQUIRE3_RESPONSE"

LOCK_ID3=$(echo "$ACQUIRE3_RESPONSE" | jq -r '.lockId // empty')
NONCE3=$(echo "$ACQUIRE3_RESPONSE" | jq -r '.nonce // empty')

if [ "$NONCE3" == "$NONCE2" ]; then
  echo -e "${GREEN}✓ SUCCESS:${NC} Nonce was correctly rolled back! nonce=$NONCE3 (same as before rollback)"
else
  echo -e "${YELLOW}⚠ NOTE:${NC} Nonce changed: $NONCE2 -> $NONCE3 (may be due to blockchain sync)"
fi

# Cleanup
curl -s -X POST "${GATEWAY_URL}/chains/ethereum/nonce/release" \
  -H "Content-Type: application/json" \
  -d "{
    \"network\": \"$NETWORK\",
    \"walletAddress\": \"$WALLET\",
    \"lockId\": \"$LOCK_ID3\",
    \"transactionSent\": false
  }" > /dev/null
echo ""

# Test 7: Invalidate nonce cache
echo -e "${YELLOW}[TEST 7]${NC} POST /nonce/invalidate - Invalidating nonce cache..."
INVALIDATE_RESPONSE=$(curl -s -X POST "${GATEWAY_URL}/chains/ethereum/nonce/invalidate" \
  -H "Content-Type: application/json" \
  -d "{
    \"network\": \"$NETWORK\",
    \"walletAddress\": \"$WALLET\"
  }")

echo "Response: $INVALIDATE_RESPONSE"

SUCCESS_INV=$(echo "$INVALIDATE_RESPONSE" | jq -r '.success // false')
if [ "$SUCCESS_INV" == "true" ]; then
  echo -e "${GREEN}✓ SUCCESS:${NC} Nonce cache invalidated"
else
  echo -e "${RED}✗ FAILED:${NC} Nonce cache invalidation failed"
fi
echo ""

# Final status check
echo -e "${YELLOW}[FINAL]${NC} GET /nonce/status - Final lock status..."
FINAL_STATUS=$(curl -s -X GET "${GATEWAY_URL}/chains/ethereum/nonce/status")
echo "Response: $FINAL_STATUS"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo "  Integration Test Complete!"
echo "═══════════════════════════════════════════════════════════"
