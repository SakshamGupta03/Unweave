#!/usr/bin/env bash
# ============================================================
# Unweave — macOS Native App & Custom DMG Packager
# Builds a standalone Unweave.app and styled drag-and-drop Unweave.dmg
# ============================================================

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist-desktop"
ELECTRON_APP="$ROOT_DIR/desktop/node_modules/electron/dist/Electron.app"
APP_NAME="Unweave"
VOL_NAME="Unweave Studio"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
DMG_PATH="$DIST_DIR/$APP_NAME.dmg"
DMG_TMP="$DIST_DIR/tmp-$APP_NAME.dmg"

echo ""
echo -e "${CYAN}====================================================${NC}"
echo -e "${CYAN}   Unweave — Native macOS App & DMG Packaging       ${NC}"
echo -e "${CYAN}====================================================${NC}"
echo ""

# -----------------------------------------------------------
# 1. Build Frontend Production Assets
# -----------------------------------------------------------
echo -e "${YELLOW}[1/6] Compiling Frontend Assets (React 19 + Vite)...${NC}"
cd "$ROOT_DIR/frontend"
npm run build
echo -e "  ${GREEN}✅ Frontend compilation complete${NC}"

# -----------------------------------------------------------
# 2. Check Electron Runtime
# -----------------------------------------------------------
echo -e "${YELLOW}[2/6] Verifying Electron macOS Runtime...${NC}"
if [ ! -d "$ELECTRON_APP" ]; then
    echo -e "${RED}❌ Electron runtime not found at $ELECTRON_APP.${NC}"
    echo -e "Please run: npm install --prefix desktop"
    exit 1
fi
echo -e "  ${GREEN}✅ Electron runtime verified${NC}"

# -----------------------------------------------------------
# 3. Create .app Bundle
# -----------------------------------------------------------
echo -e "${YELLOW}[3/6] Assembling $APP_NAME.app bundle...${NC}"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

cp -R "$ELECTRON_APP" "$APP_BUNDLE"

# Rename binary
mv "$APP_BUNDLE/Contents/MacOS/Electron" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"

# Update Info.plist properties
PLIST="$APP_BUNDLE/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "Unweave" "$PLIST"
plutil -replace CFBundleName -string "Unweave" "$PLIST"
plutil -replace CFBundleExecutable -string "Unweave" "$PLIST"
plutil -replace CFBundleIdentifier -string "com.unweave.studio" "$PLIST"
plutil -replace CFBundleShortVersionString -string "1.0.2" "$PLIST"
plutil -replace CFBundleVersion -string "1.0.2" "$PLIST"
plutil -replace CFBundleIconFile -string "Unweave.icns" "$PLIST"

# Remove Electron default app
rm -f "$APP_BUNDLE/Contents/Resources/default_app.asar"

# Install app resources
APP_RESOURCES_DIR="$APP_BUNDLE/Contents/Resources/app"
mkdir -p "$APP_RESOURCES_DIR"

cp "$ROOT_DIR/desktop/main.js" "$APP_RESOURCES_DIR/main.js"
cp "$ROOT_DIR/desktop/preload.js" "$APP_RESOURCES_DIR/preload.js"
cp "$ROOT_DIR/desktop/package.json" "$APP_RESOURCES_DIR/package.json"

mkdir -p "$APP_RESOURCES_DIR/frontend"
cp -R "$ROOT_DIR/frontend/dist" "$APP_RESOURCES_DIR/frontend/dist"

# Copy Icon
if [ -f "$ROOT_DIR/desktop/assets/Unweave.icns" ]; then
    cp "$ROOT_DIR/desktop/assets/Unweave.icns" "$APP_BUNDLE/Contents/Resources/Unweave.icns"
    cp "$ROOT_DIR/desktop/assets/Unweave.icns" "$APP_BUNDLE/Contents/Resources/electron.icns"
fi

# -----------------------------------------------------------
# 4. Embed Python Backend Source Code
# -----------------------------------------------------------
echo -e "${YELLOW}[4/6] Embedding Python AI Backend Source Code...${NC}"
BACKEND_APP_DIR="$APP_BUNDLE/Contents/Resources/backend"
mkdir -p "$BACKEND_APP_DIR"
mkdir -p "$BACKEND_APP_DIR/static_stems"
mkdir -p "$BACKEND_APP_DIR/temp_audio"
mkdir -p "$BACKEND_APP_DIR/models"

cp "$ROOT_DIR/backend/main.py" "$BACKEND_APP_DIR/main.py"
cp "$ROOT_DIR/backend/worker.py" "$BACKEND_APP_DIR/worker.py"
cp "$ROOT_DIR/backend/requirements.txt" "$BACKEND_APP_DIR/requirements.txt"

# Clean any broken symlinks or temporary files in the bundle
find "$APP_BUNDLE" -type l -exec test ! -e {} \; -delete 2>/dev/null || true

echo -e "  ${GREEN}✅ Python AI backend sources embedded into app bundle${NC}"

# -----------------------------------------------------------
# 5. Ad-Hoc Sign App Bundle (Inside-Out)
# -----------------------------------------------------------
echo -e "${YELLOW}[5/6] Code-signing $APP_NAME.app (Ad-Hoc, Inside-Out)...${NC}"

# Remove extended quarantine attributes that could interfere with execution
xattr -cr "$APP_BUNDLE" 2>/dev/null || true

# Sign Electron Frameworks & Helpers
if [ -d "$APP_BUNDLE/Contents/Frameworks" ]; then
    find "$APP_BUNDLE/Contents/Frameworks" -depth \( -name "*.app" -o -name "*.framework" -o -name "*.dylib" \) | while read -r fw; do
        codesign --force --sign - "$fw" 2>/dev/null || true
    done
fi

# Finally, sign the outer application bundle
codesign --force --deep --sign - "$APP_BUNDLE"

# Verify bundle signature strictly
echo -e "  Verifying bundle signature..."
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"
echo -e "  ${GREEN}✅ App bundle signed and verified successfully${NC}"

# -----------------------------------------------------------
# 6. Build Drag-and-Drop .dmg Installer
# -----------------------------------------------------------
echo -e "${YELLOW}[6/6] Creating $APP_NAME.dmg Installer...${NC}"
DMG_STAGE="$DIST_DIR/dmg_staging"
rm -rf "$DMG_STAGE" "$DMG_PATH" "$DMG_TMP"
mkdir -p "$DMG_STAGE"

# Copy App Bundle and create Applications symlink
cp -R "$APP_BUNDLE" "$DMG_STAGE/$APP_NAME.app"
ln -s /Applications "$DMG_STAGE/Applications"

# Build pristine compressed read-only DMG directly from staging folder
hdiutil create \
    -volname "$VOL_NAME" \
    -srcfolder "$DMG_STAGE" \
    -ov \
    -format UDZO \
    -imagekey zlib-level=9 \
    "$DMG_PATH" >/dev/null

rm -rf "$DMG_STAGE"

echo ""
echo -e "${GREEN}====================================================${NC}"
echo -e "${GREEN}   🎉 Packaging Complete!                          ${NC}"
echo -e "${GREEN}====================================================${NC}"
echo ""
echo -e "  📂 App Bundle:  ${CYAN}$APP_BUNDLE${NC}"
echo -e "  💿 DMG Package: ${CYAN}$DMG_PATH${NC} ($(du -sh "$DMG_PATH" | cut -f1))"
echo ""
echo -e "Double-click ${CYAN}$DMG_PATH${NC} and drag ${APP_NAME} to Applications!"
echo ""
