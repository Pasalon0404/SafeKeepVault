import * as btc from '@scure/btc-signer';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import QRCode from 'qrcode';

// --- Configuration & State ---
const NETWORKS = {
    mainnet: {
        bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05,
        bip32: { public: 0x0488b21e, private: 0x0488ade4 }
    },
    testnet: {
        bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4,
        bip32: { public: 0x043587cf, private: 0x04358394 }
    },
    signet: {
        bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4,
        bip32: { public: 0x043587cf, private: 0x04358394 }
    },
    regtest: {
        bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4,
        bip32: { public: 0x043587cf, private: 0x04358394 }
    }
};

let currentNetwork = 'testnet';
let loadedPsbtBytes = null;
let transactionIsFinalized = false;

// --- Helper Utilities ---
function formatPath(path) {
    if (!path) return null;
    if (typeof path === 'string') {
        if (path.startsWith('m/')) return path;
        if (path.startsWith('/')) return 'm' + path;
        return 'm/' + path;
    }
    if (Array.isArray(path) || ArrayBuffer.isView(path) || typeof path.length === 'number') {
        let str = 'm';
        for (let j = 0; j < path.length; j++) {
            const n = Number(path[j]) >>> 0; 
            const isHardened = n >= 0x80000000;
            str += '/' + (isHardened ? `${n - 0x80000000}'` : `${n}`);
        }
        return str;
    }
    return null;
}

function formatAmount(satoshis) {
    const sats = Number(satoshis).toLocaleString();
    const btcAmount = (Number(satoshis) / 100000000).toFixed(8);
    return { sats, btc: btcAmount };
}

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength || bytes.length;
    for (let i = 0; i < len; i++) { binary += String.fromCharCode(bytes[i]); }
    return btoa(binary);
}

function showStatus(message, type = '') {
    const statusEl = document.getElementById('status');
    statusEl.className = type ? type : '';
    statusEl.innerHTML = type === 'error' ? `<span style="color: var(--error-color);">❌ ${message}</span>` : message;
}

function showSpinner() {
    return '<div class="spinner"></div>Processing...';
}

function zeroFillArray(arr) {
    if (arr && arr.fill) arr.fill(0);
}

function clearSensitiveData() {
    document.getElementById('seedPhrase').value = '';
    document.getElementById('passphrase').value = '';
    if (loadedPsbtBytes) {
        zeroFillArray(loadedPsbtBytes);
        loadedPsbtBytes = null;
    }
}

// --- QR Code Logic ---
async function generateQRCode(text, containerId, title) {
    try {
        const canvas = document.createElement('canvas');
        await QRCode.toCanvas(canvas, text, {
            width: 600,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        
        const qrItem = document.createElement('div');
        qrItem.className = 'qr-item';
        
        const titleEl = document.createElement('h5');
        titleEl.textContent = title;
        
        const canvasWrapper = document.createElement('div');
        canvasWrapper.className = 'qr-canvas';
        canvasWrapper.appendChild(canvas);
        
        const infoEl = document.createElement('div');
        infoEl.className = 'qr-info';
        infoEl.textContent = 'Scan with mobile wallet';
        
        qrItem.appendChild(titleEl);
        qrItem.appendChild(canvasWrapper);
        qrItem.appendChild(infoEl);
        
        document.getElementById(containerId).appendChild(qrItem);
    } catch (error) {
        console.error('Failed to generate QR code:', error);
        let errMsg = error.message;
        if (errMsg && errMsg.includes("too big")) {
            errMsg = "Transaction is too large for a single static QR. Please download the file.";
        }
        const errorMsg = document.createElement('div');
        errorMsg.className = 'error';
        errorMsg.textContent = `QR generation failed: ${errMsg}`;
        document.getElementById(containerId).appendChild(errorMsg);
    }
}

// --- PSBT Processing & UI ---
function parseOutputScript(script) {
    try {
        const decodedScript = btc.OutScript.decode(script);
        try {
            const address = btc.Address(NETWORKS[currentNetwork]).encode(decodedScript);
            return { address: address, type: getScriptType(decodedScript), scriptHex: bytesToHex(script) };
        } catch (addressErr) {
            return { address: null, type: getScriptType(decodedScript), scriptHex: bytesToHex(script) };
        }
    } catch (scriptErr) {
        return { address: null, type: 'Unknown', scriptHex: bytesToHex(script) };
    }
}

function getScriptType(decoded) {
    if (decoded.type === 'p2pkh') return 'Pay to Public Key Hash';
    if (decoded.type === 'p2sh') return 'Pay to Script Hash';
    if (decoded.type === 'p2wpkh') return 'Pay to Witness Public Key Hash';
    if (decoded.type === 'p2wsh') return 'Pay to Witness Script Hash';
    if (decoded.type === 'taproot') return 'Taproot';
    return 'Custom Script';
}

async function parseAndDisplayPSBT(file) {
    try {
        showStatus(showSpinner());
        const arrayBuffer = await file.arrayBuffer();
        loadedPsbtBytes = new Uint8Array(arrayBuffer);
        const tx = btc.Transaction.fromPSBT(loadedPsbtBytes, { network: NETWORKS[currentNetwork] });
        
        const { walletType, totalKeys, requiredSigs } = parseSecurityModel(tx);
        const outputsInfo = parseOutputs(tx);
        const inputsInfo = parseInputs(tx);
        
        buildTransactionDisplay(walletType, totalKeys, requiredSigs, outputsInfo, inputsInfo);
        
        document.getElementById('signingStep').style.display = 'block';
        document.getElementById('reviewStep').style.display = 'block';
        
        if (!inputsInfo.canCalculateFee) {
            document.getElementById('feeRateSection').style.display = 'block';
        }
        document.getElementById('rawHexOption').style.display = 'flex';
        showStatus('✅ PSBT loaded successfully!', 'success');
        
    } catch (error) {
        console.error("Parse Error:", error);
        showStatus(`Error decoding PSBT: ${error.message}`, 'error');
        document.getElementById('reviewStep').style.display = 'block';
    }
}

function parseSecurityModel(tx) {
    try {
        const firstInput = tx.inputs[0];
        let totalKeys = 1;
        let requiredSigs = 1;
        let walletType = 'Single-Signature (1-of-1)';

        if (firstInput.bip32Derivation) { totalKeys = firstInput.bip32Derivation.length; } 
        else if (firstInput.tapBip32Derivation) { totalKeys = firstInput.tapBip32Derivation.length; }

        if (totalKeys > 1) {
            requiredSigs = "Multiple"; 
            const script = firstInput.witnessScript || firstInput.redeemScript;
            if (script && script[script.length - 1] === 174) { 
                const possibleM = script[0] - 80;
                if (possibleM > 0 && possibleM <= totalKeys) { requiredSigs = possibleM; }
            }
            walletType = `${requiredSigs}-of-${totalKeys} Multi-Signature`;
        }
        return { walletType, totalKeys, requiredSigs };
    } catch (err) {
        return { walletType: 'Unknown', totalKeys: 1, requiredSigs: 1 };
    }
}

function parseOutputs(tx) {
    const outputs = [];
    let totalOut = 0n;
    tx.outputs.forEach((out, index) => {
        totalOut += out.amount;
        const { sats, btc: btcAmount } = formatAmount(out.amount);
        const scriptInfo = parseOutputScript(out.script);
        const isChange = !!(out.bip32Derivation || out.tapBip32Derivation);
        outputs.push({ index, amount: out.amount, sats, btc: btcAmount, address: scriptInfo.address, scriptType: scriptInfo.type, scriptHex: scriptInfo.scriptHex, isChange });
    });
    return { outputs, totalOut };
}

function parseInputs(tx) {
    let totalIn = 0n;
    let canCalculateFee = true;
    tx.inputs.forEach((input) => {
        if (input.witnessUtxo) { totalIn += input.witnessUtxo.amount; } 
        else { canCalculateFee = false; }
    });
    return { totalIn, canCalculateFee };
}

function buildTransactionDisplay(walletType, totalKeys, requiredSigs, outputsInfo, inputsInfo) {
    let html = `<div class="security-model">
        <h4 style="color: var(--info-color); margin-top: 0;">🔐 Security Model</h4>
        <p style="margin: 0;"><strong>${walletType}</strong></p>
        ${totalKeys > 1 ? `<p style="font-size: 0.9em; margin: 5px 0 0 0; color: var(--text-color);">Multi-sig: Enter ONE valid seed for this transaction.</p>` : ''}
    </div><div class="tx-section"><h4>📤 Outputs (${outputsInfo.outputs.length})</h4>`;
    
    outputsInfo.outputs.forEach((output) => {
        const cssClass = output.isChange ? 'change-output' : 'destination-output';
        const typeClass = output.isChange ? 'change' : 'destination';
        const label = output.isChange ? '🔄 CHANGE' : '📍 SENDING TO';
        
        html += `<div class="output-item ${cssClass}">
            <div class="output-header">
                <div class="output-type ${typeClass}">${label}</div>
                <div class="output-amount">${output.sats} sats <span class="btc-amount">(${output.btc} BTC)</span></div>
            </div>
            <div class="output-address">
                <div class="address-label">Address:</div>
                <div class="address-value">${output.address || 'Unknown Address'}</div>
                <div style="margin-top: 5px; font-size: 12px; color: var(--text-color); opacity: 0.7;">Type: ${output.scriptType}</div>
            </div>
        </div>`;
    });
    html += `</div>`;
    
    if (inputsInfo.canCalculateFee) {
        const fee = inputsInfo.totalIn - outputsInfo.totalOut;
        const { sats: feeSats, btc: feeBtc } = formatAmount(fee);
        html += `<div class="fee-info">
            <h4 style="color: var(--warning-color); margin-top: 0;">⛏️ Fee Info</h4>
            <div><strong>Total Fee:</strong> ${feeSats} sats (${feeBtc} BTC)</div>
        </div>`;
    }
    document.getElementById('txDetails').innerHTML = html;
}

// --- Signing Logic ---
async function signTransaction() {
    const seedText = document.getElementById('seedPhrase').value.trim().toLowerCase().replace(/\s+/g, ' ');
    const passphraseText = document.getElementById('passphrase').value;
    const includeRawHex = document.getElementById('includeRawHex').checked;
    
    if (!loadedPsbtBytes || !seedText) {
        showStatus('Error: Provide PSBT and seed phrase.', 'error');
        return;
    }

    const signBtn = document.getElementById('signBtn');
    signBtn.disabled = true;
    showStatus(showSpinner());

    try {
        document.getElementById('downloadArea').innerHTML = '';
        document.getElementById('qrDisplay').innerHTML = '';
        document.getElementById('qrDisplay').style.display = 'none';
        
        const tx = btc.Transaction.fromPSBT(loadedPsbtBytes, { network: NETWORKS[currentNetwork] });
        let seed;
        try { seed = mnemonicToSeedSync(seedText, passphraseText); } 
        catch (e) { throw new Error("Invalid seed phrase."); }

        const masterKey = HDKey.fromMasterSeed(seed, NETWORKS[currentNetwork].bip32);
        const getSigCount = (t) => {
            let count = 0;
            t.inputs.forEach(inp => {
                if (inp.partialSig) count += (inp.partialSig instanceof Map) ? inp.partialSig.size : Object.keys(inp.partialSig).length;
                if (inp.tapKeySig) count++;
                if (inp.finalScriptWitness || inp.finalScriptSig) count++;
            });
            return count;
        };

        const initialSigs = getSigCount(tx);
        const pathsToTry = new Set();
        
        // 1. Smart Extraction: Read the exact paths Sparrow Wallet put in the PSBT
        const extractPaths = (obj) => {
            if (!obj) return;
            if (typeof obj === 'object') {
                if (obj.path) {
                    const p = formatPath(obj.path);
                    if (p) pathsToTry.add(p);
                }
                if (obj instanceof Map) { for (const v of obj.values()) extractPaths(v); } 
                else if (Array.isArray(obj)) { for (const v of obj) extractPaths(v); } 
                else { for (const k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) { extractPaths(obj[k]); } } }
            }
        };
        tx.inputs.forEach(inp => { extractPaths(inp.bip32Derivation); extractPaths(inp.tapBip32Derivation); });

        // 2. Brute Force Fallback (Now includes Multisig paths 45, 48, 87)
        const purposes = [44, 45, 48, 49, 84, 86, 87]; 
        for (let p of purposes) {
            for (let c of [0, 1]) { // Mainnet (0) and Testnet (1)
                for (let ch = 0; ch <= 1; ch++) {
                    for (let idx = 0; idx < 20; idx++) { pathsToTry.add(`m/${p}'/${c}'/0'/${ch}/${idx}`); }
                }
            }
        }

        // 3. Attempt to sign with all gathered paths
        for (const path of pathsToTry) {
            try {
                const childKey = masterKey.derive(path);
                if (childKey.privateKey) { tx.sign(childKey.privateKey); }
            } catch (e) {}
        }

        const finalSigs = getSigCount(tx);
        const signaturesAdded = finalSigs - initialSigs;

        if (signaturesAdded === 0) throw new Error("No signatures were added. Verify your seed.");

        transactionIsFinalized = false;
        try { tx.finalize(); transactionIsFinalized = true; } 
        catch (e) { console.log('Partially signed.'); }
        
        const signedPsbtBytes = tx.toPSBT();
        zeroFillArray(seed);
        clearSensitiveData();
        
        offerDownloads(signedPsbtBytes, transactionIsFinalized, signaturesAdded, includeRawHex);
        await displayQRCode(signedPsbtBytes, transactionIsFinalized, includeRawHex);

    } catch (error) {
        showStatus(`Error: ${error.message}`, 'error');
    } finally {
        signBtn.disabled = false;
    }
}

async function displayQRCode(signedPsbtBytes, isFinalized, includeRawHex) {
    const qrDisplay = document.getElementById('qrDisplay');
    qrDisplay.innerHTML = '<div class="qr-section"><h4>📱 QR Result</h4><div class="qr-container" id="qrContainer"></div></div>';
    qrDisplay.style.display = 'block';
    await generateQRCode(bytesToBase64(signedPsbtBytes), 'qrContainer', isFinalized ? 'Final PSBT' : 'Partial PSBT');
}

function offerDownloads(signedPsbtBytes, isFinalized, signaturesAdded, includeRawHex) {
    const downloadArea = document.getElementById('downloadArea');
    const blob = new Blob([signedPsbtBytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = isFinalized ? 'signed-finalized.psbt' : 'signed-partial.psbt';
    downloadLink.className = `download-link ${isFinalized ? '' : 'partial'}`;
    downloadLink.innerText = isFinalized ? '💾 Download Finalized PSBT' : '💾 Download Partial PSBT';
    downloadArea.appendChild(downloadLink);
    
    showStatus(`✅ Added ${signaturesAdded} signature(s).`, 'success');
}

function resetAll() {
    document.getElementById('psbtInput').value = '';
    document.getElementById('reviewStep').style.display = 'none';
    document.getElementById('signingStep').style.display = 'none';
    document.getElementById('status').innerHTML = '';
    clearSensitiveData();
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('networkSelect').addEventListener('change', (e) => { currentNetwork = e.target.value; resetAll(); });
    document.getElementById('psbtInput').addEventListener('change', async (e) => {
        if (e.target.files.length) await parseAndDisplayPSBT(e.target.files[0]);
    });
    document.getElementById('signBtn').addEventListener('click', signTransaction);
    document.getElementById('resetBtn').addEventListener('click', resetAll);
});