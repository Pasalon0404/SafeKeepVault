import * as bip39 from 'bip39';
import { BIP85 } from 'bip85';

// 1. The Core Derivation Logic
function deriveBIP85Seed(masterMnemonic, index, wordLength) {
    if (!bip39.validateMnemonic(masterMnemonic)) {
        throw new Error("Invalid master seed phrase. Please check your spelling.");
    }
    const masterSeed = BIP85.fromMnemonic(masterMnemonic);
    const languageCode = 0; // English
    const childSeed = masterSeed.deriveBIP39(languageCode, wordLength, index);
    return childSeed.toMnemonic();
}

// 2. Wiring it to the HTML
document.addEventListener('DOMContentLoaded', () => {
    const deriveBtn = document.getElementById('derive-btn');
    const masterSeedInput = document.getElementById('master-seed');
    const indexInput = document.getElementById('bip85-index');
    const wordLengthSelect = document.getElementById('word-length');
    const outputSeed = document.getElementById('output-seed');
    const errorMessage = document.getElementById('error-message');
    const outputIndex = document.getElementById('output-index'); // <-- Grab the new HTML element

    deriveBtn.addEventListener('click', () => {
        // Clear previous outputs and hide the result box initially
        errorMessage.textContent = '';
        outputSeed.innerText = '';
        outputIndex.innerText = ''; // <-- Clear previous index
        document.getElementById('result').style.display = 'none';

        try {
            // Grab the user inputs
            const masterMnemonic = masterSeedInput.value.trim().toLowerCase();
            const index = parseInt(indexInput.value, 10);
            const wordLength = parseInt(wordLengthSelect.value, 10);

            // Basic validation
            if (!masterMnemonic) throw new Error("Please enter a master seed phrase.");
            if (isNaN(index) || index < 0) throw new Error("Index must be a positive number.");

            // Derive and display
            const derived = deriveBIP85Seed(masterMnemonic, index, wordLength);
            
            // Set the text, the index, and reveal the output box
            outputSeed.innerText = derived;
            outputIndex.innerText = index; // <-- Inject the index number
            document.getElementById('result').style.display = 'block';

        } catch (error) {
            // Display errors to the user
            errorMessage.textContent = error.message;
        }
    });
});