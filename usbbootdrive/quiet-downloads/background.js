// SafeKeep Quiet Downloads, loaded by safekeep-boot.sh with --load-extension.
//
// The app asks the OS for things (mount the Transfer Drive, check for an
// update, lock, save settings...) by downloading small request files into
// Chromium's download folder, where safekeep-boot.sh's watchers pick them
// up. Nothing leaves the computer, but in kiosk mode Chromium shows
// "Download started. To see it, press Esc." for each one, which looks
// alarming. No flag or policy turns that message off; turning off the
// download UI does. The files are still written as before.
//
// This extension has no other code and no access to any page.
function hideDownloadUi() {
    chrome.downloads.setUiOptions({ enabled: false }).catch(function () {});
}

hideDownloadUi();
chrome.runtime.onStartup.addListener(hideDownloadUi);
chrome.runtime.onInstalled.addListener(hideDownloadUi);
