#!/usr/bin/env node

const art = `
\x1b[36m\x1b[1m █████╗  ██████╗ ███████╗███╗   ██╗████████╗ ██████╗  █████╗ 
██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔═══██╗██╔══██╗
███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║   ██║███████║
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║▄▄ ██║██╔══██║
██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ╚██████╔╝██║  ██║
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝    ╚═══▀▀╝ ╚═╝  ╚═╝\x1b[0m
`;

console.log(art);
console.log("\x1b[32m\x1b[1m🚀 AgentQA successfully installed!\x1b[0m");
console.log("\x1b[37m🤖 AI-powered QA automation for coding agents & CI/CD\x1b[0m");
console.log("\x1b[35m✨ Created by Ali Sharjeel\x1b[0m");
console.log("");

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function hasBrowserHarness() {
  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (userProfile) {
    const pythonExePath = path.join(userProfile, 'AppData', 'Roaming', 'uv', 'tools', 'browser-harness', 'Scripts', 'python.exe');
    if (fs.existsSync(pythonExePath)) return true;
    const uvToolPath = path.join(userProfile, '.local', 'bin', 'browser-harness.exe');
    if (fs.existsSync(uvToolPath)) return true;
  }
  try {
    const checkCmd = process.platform === 'win32' ? 'where browser-harness' : 'which browser-harness';
    execSync(checkCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!hasBrowserHarness()) {
  console.log("\x1b[33m🔍 Checking browser-harness installation...\x1b[0m");
  console.log("\x1b[33mBrowser-harness is required for AgentQA but was not found.\x1b[0m");
  try {
    console.log("Attempting to install browser-harness via uv...");
    execSync('uv tool install git+https://github.com/browser-use/browser-harness', { stdio: 'inherit' });
    console.log("\x1b[32m✔ browser-harness installed successfully!\x1b[0m");
  } catch {
    try {
      console.log("uv not found. Attempting to install browser-harness via pip...");
      execSync('pip install git+https://github.com/browser-use/browser-harness', { stdio: 'inherit' });
      console.log("\x1b[32m✔ browser-harness installed successfully!\x1b[0m");
    } catch {
      console.log("\x1b[31m⚠ Could not automatically install browser-harness.\x1b[0m");
      console.log("Please install it manually using:");
      console.log("  \x1b[36muv tool install git+https://github.com/browser-use/browser-harness\x1b[0m");
    }
  }
  console.log("");
} else {
  console.log("\x1b[32m✔ browser-harness is already installed.\x1b[0m\n");
}

console.log("\x1b[33mGet started with:\x1b[0m");
console.log("  \x1b[36magentqa config\x1b[0m             Configure API keys & vision mode");
console.log("  \x1b[36magentqa <url> <prompt>\x1b[0m     Run a QA task");
console.log("  \x1b[36magentqa app\x1b[0m                Launch the Electron Desktop GUI");
console.log("");
console.log("\x1b[90mDocumentation & info: https://github.com/AliSharjeell/AgentQA\x1b[0m");
console.log("");
