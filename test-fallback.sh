#!/bin/bash
# Test script for Claude Agent SDK fallback

set -e

echo "=========================================="
echo "Testing Claude Agent SDK Fallback"
echo "=========================================="
echo

# Check if Claude CLI is installed
if ! command -v claude &> /dev/null; then
    echo "⚠️  Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
    echo "After installing, run: claude login"
    exit 1
fi

# Check if Claude is authenticated
if ! claude auth status &> /dev/null; then
    echo "⚠️  Claude CLI not authenticated. Run: claude login"
    exit 1
fi

echo "✓ Claude CLI installed and authenticated"
echo

# Build the project
echo "Building project..."
npm run build
echo "✓ Build complete"
echo

# Test 1: Invalid token should trigger immediate fallback
echo "Test 1: Invalid Copilot token → immediate fallback"
echo "----------------------------------------"
export GITHUB_PAT_TOKENS="ghp_invalidtoken123"
export DISABLE_CLAUDE_CODE_FALLBACK=false

echo "Starting MCP server with invalid Copilot token..."
echo "You should see:"
echo "  1. '[sdk-spawner] No Copilot accounts available for task <id>, using Claude Agent SDK'"
echo "  2. Task completes successfully via Claude Agent SDK"
echo
echo "Press Ctrl+C when you've verified the fallback works"
echo

npm start

# Test 2: Disabled fallback should fail
echo
echo "Test 2: Disabled fallback → task fails"
echo "----------------------------------------"
export DISABLE_CLAUDE_CODE_FALLBACK=true

echo "Starting MCP server with fallback disabled..."
echo "You should see:"
echo "  1. Task fails with 'All accounts exhausted'"
echo "  2. No fallback to Claude Agent SDK"
echo
echo "Press Ctrl+C when you've verified failure behavior"
echo

npm start
