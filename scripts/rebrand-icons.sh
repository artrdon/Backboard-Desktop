#!/usr/bin/env bash
#
# Rebuild every application icon asset from one square PNG.
#
# Usage:
#   scripts/rebrand-icons.sh path/to/logo.png [options]
#
# Options:
#   --app-dir DIR   Path to the app directory (default: <repo>/backboard)
#   --dock          Also overwrite the macOS Dock variants
#                   (<app>/src/vs/code/electron-main/media/dock-*.png)
#   --in-app        Also rebuild the SVG logos inside the UI (needs python3)
#   --skip-icns     Leave resources/darwin/code.icns untouched
#   --dry-run       Print the planned writes without touching any file
#   -h, --help      Show this help
#
# Assets produced from the source image:
#   resources/linux/code.png          1024x1024 PNG (RGBA)
#   resources/linux/rpm/code.xpm      256x256 XPM (at most 64 colours)
#   resources/win32/code.ico          16, 24, 32, 48, 64, 128, 256
#   resources/win32/code_150x150.png  150x150 PNG
#   resources/win32/code_70x70.png    70x70 PNG
#   resources/server/code-512.png     512x512 PNG
#   resources/server/code-192.png     192x192 PNG
#   resources/server/favicon.ico      16, 32, 48
#   resources/darwin/code.icns        ICNS, 16..1024 PNG frames
#   resources/darwin/code-dev-8bit.icns
#                                     ICNS used by the dev Electron bundle
#   resources/win32/inno-*.bmp        Inno Setup wizard images (blue logo on white)
#
# With --in-app the UI logos are rewritten as 256px PNGs embedded in SVG, using
# the colour each surface expects (black silhouettes for the mark/title icons,
# #D9D9D9 for the dark-theme sessions logo, brand blue for the blue mark).
#
# The <app>/out copies of the UI media are refreshed too when they exist, so a
# running dev build picks the new art up after a window reload.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${REPO_ROOT}/backboard"
SOURCE=""
DOCK=0
IN_APP=0
SKIP_ICNS=0
DRY_RUN=0

usage() {
	cat <<'EOF'
Rebuild every application icon asset from one square PNG.

Usage:
  scripts/rebrand-icons.sh path/to/logo.png [options]

Options:
  --app-dir DIR   Path to the app directory (default: <repo>/backboard)
  --dock          Also overwrite the macOS Dock variants
                  (<app>/src/vs/code/electron-main/media/dock-*.png)
  --in-app        Also rebuild the SVG logos inside the UI (needs python3)
  --skip-icns     Leave resources/darwin/code.icns untouched
  --dry-run       Print the planned writes without touching any file
  -h, --help      Show this help

The source image must be square and at least 256x256; 1024x1024 is recommended.
Transparency is preserved, so draw the artwork on a transparent canvas.
EOF
}

die() {
	echo "error: $*" >&2
	exit 1
}

warn() {
	echo "warning: $*" >&2
}

note() {
	echo "  $*"
}

while (($#)); do
	case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		--app-dir)
			[[ $# -ge 2 ]] || die "--app-dir requires a value"
			APP_DIR="$2"
			shift 2
			;;
		--app-dir=*)
			APP_DIR="${1#*=}"
			shift
			;;
		--dock)
			DOCK=1
			shift
			;;
		--in-app)
			IN_APP=1
			shift
			;;
		--skip-icns)
			SKIP_ICNS=1
			shift
			;;
		--dry-run)
			DRY_RUN=1
			shift
			;;
		-*)
			die "unknown option: $1 (see --help)"
			;;
		*)
			[[ -z "${SOURCE}" ]] || die "only one source image is accepted"
			SOURCE="$1"
			shift
			;;
	esac
done

if [[ -z "${SOURCE}" ]]; then
	usage >&2
	exit 2
fi

[[ -f "${SOURCE}" ]] || die "source image not found: ${SOURCE}"
[[ -d "${APP_DIR}" ]] || die "app directory not found: ${APP_DIR}"
APP_DIR="$(cd "${APP_DIR}" && pwd)"

if command -v magick >/dev/null 2>&1; then
	MAGICK=(magick)
	IDENTIFY=(magick identify)
elif command -v convert >/dev/null 2>&1 && command -v identify >/dev/null 2>&1; then
	MAGICK=(convert)
	IDENTIFY=(identify)
else
	die "ImageMagick is required (install the 'magick' or 'convert' command)"
fi

SOURCE_INFO="$("${IDENTIFY[@]}" -format '%w %h %m %[channels]\n' "${SOURCE}[0]" 2>/dev/null | head -n 1)"
[[ -n "${SOURCE_INFO}" ]] || die "cannot read ${SOURCE} with ImageMagick"
read -r SOURCE_W SOURCE_H SOURCE_FORMAT SOURCE_CHANNELS <<<"${SOURCE_INFO}"
SOURCE_CHANNELS="${SOURCE_CHANNELS%% *}"

if [[ "${SOURCE_W}" != "${SOURCE_H}" ]]; then
	die "source must be square, got ${SOURCE_W}x${SOURCE_H}"
fi
if ((SOURCE_W < 256)); then
	die "source must be at least 256x256, got ${SOURCE_W}x${SOURCE_H}"
fi
if ((SOURCE_W < 1024)); then
	warn "source is ${SOURCE_W}x${SOURCE_H}; 1024x1024 avoids upscaling artefacts"
fi
if [[ "${SOURCE_CHANNELS}" != *a* ]]; then
	warn "source has no alpha channel (${SOURCE_CHANNELS}); icons will have an opaque background"
fi
if [[ "${SOURCE_FORMAT}" != "PNG" ]]; then
	warn "source format is ${SOURCE_FORMAT}; PNG is recommended"
fi

for dir in resources/linux resources/linux/rpm resources/win32 resources/server resources/darwin; do
	[[ -d "${APP_DIR}/${dir}" ]] || die "missing ${APP_DIR}/${dir}; point --app-dir at the repo's 'backboard' directory"
done
if ((DOCK)) && [[ ! -d "${APP_DIR}/src/vs/code/electron-main/media" ]]; then
	die "missing ${APP_DIR}/src/vs/code/electron-main/media; --dock needs the sources"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rebrand-icons.XXXXXX")"
cleanup() {
	rm -rf "${WORK}"
}
trap cleanup EXIT INT TERM

# Renders the source into an exact, alpha-preserving PNG of the given size.
render() {
	local size="$1" out="$2"
	"${MAGICK[@]}" "${SOURCE}" \
		-background none -alpha on \
		-filter Lanczos -resize "${size}x${size}!" \
		-strip "PNG32:${out}"
}

describe() {
	local path="$1"
	case "${path}" in
		*.icns)
			if command -v python3 >/dev/null 2>&1; then
				python3 - "${path}" <<-'PY'
					import struct
					import sys

					data = open(sys.argv[1], 'rb').read()
					offset, frames = 8, []
					while offset < len(data):
					    frames.append(data[offset:offset + 4].decode('latin1'))
					    offset += struct.unpack('>I', data[offset + 4:offset + 8])[0]
					print(f"{len(frames)} frames ({', '.join(frames)})")
				PY
			else
				echo "ICNS"
			fi
			;;
		*.ico)
			"${IDENTIFY[@]}" -format '%wx%h ' "${path}" 2>/dev/null | sed 's/ $//'
			;;
		*)
			"${IDENTIFY[@]}" -format '%wx%h %[channels]\n' "${path}[0]" 2>/dev/null | awk '{ print $1, $2; exit }' || true
			;;
	esac
}

install_asset() {
	local src="$1" dest="$2"
	if ((DRY_RUN)); then
		printf 'dry-run  %s\n' "${dest#"${REPO_ROOT}"/}"
		return 0
	fi
	mkdir -p "$(dirname "${dest}")"
	cp "${src}" "${dest}"
	printf 'wrote    %-56s %s\n' "${dest#"${REPO_ROOT}"/}" "$(describe "${dest}")"
}

verify_dims() {
	local path="$1" expected="$2" got
	got="$("${IDENTIFY[@]}" -format '%wx%h' "${path}[0]" 2>/dev/null || echo '?')"
	[[ "${got}" == "${expected}" ]] || die "${path#"${REPO_ROOT}"/}: expected ${expected}, got ${got}"
}

verify_ico_frames() {
	local path="$1"
	shift
	local got expected
	got="$("${IDENTIFY[@]}" -format '%w\n' "${path}" 2>/dev/null | grep -E '^[0-9]+$' | sort -n | tr '\n' ' ')"
	expected="$(printf '%s\n' "$@" | sort -n | tr '\n' ' ')"
	[[ "${got}" == "${expected}" ]] || die "${path#"${REPO_ROOT}"/}: expected frames ${expected}, got ${got}"
}

verify_icns() {
	local path="$1"
	[[ "$(head -c 4 "${path}")" == "icns" ]] || die "${path#"${REPO_ROOT}"/}: not an ICNS container"
	if command -v python3 >/dev/null 2>&1; then
		python3 - "${path}" <<-'PY' || die "${path#"${REPO_ROOT}"/}: ICNS structure is invalid"
			import struct
			import sys

			data = open(sys.argv[1], 'rb').read()
			if data[:4] != b'icns':
			    sys.exit(1)
			if struct.unpack('>I', data[4:8])[0] != len(data):
			    sys.exit(1)
			offset, frames = 8, []
			while offset < len(data):
			    length = struct.unpack('>I', data[offset + 4:offset + 8])[0]
			    if length < 8 or offset + length > len(data):
			        sys.exit(1)
			    frames.append(data[offset:offset + 4].decode('latin1'))
			    offset += length
			if not any(kind in frames for kind in ('ic10', 'ic09', 'ic08', 'icp6')):
			    sys.exit(1)
		PY
	fi
}

# Builds code.icns with whichever producer is available on this machine.
build_icns() {
	local out="$1"
	if command -v iconutil >/dev/null 2>&1; then
		local iconset="${WORK}/App.iconset"
		mkdir -p "${iconset}"
		cp "${WORK}/16.png" "${iconset}/icon_16x16.png"
		cp "${WORK}/32.png" "${iconset}/icon_16x16@2x.png"
		cp "${WORK}/32.png" "${iconset}/icon_32x32.png"
		cp "${WORK}/64.png" "${iconset}/icon_32x32@2x.png"
		cp "${WORK}/128.png" "${iconset}/icon_128x128.png"
		cp "${WORK}/256.png" "${iconset}/icon_128x128@2x.png"
		cp "${WORK}/256.png" "${iconset}/icon_256x256.png"
		cp "${WORK}/512.png" "${iconset}/icon_256x256@2x.png"
		cp "${WORK}/512.png" "${iconset}/icon_512x512.png"
		cp "${WORK}/1024.png" "${iconset}/icon_512x512@2x.png"
		iconutil -c icns -o "${out}" "${iconset}"
	elif command -v png2icns >/dev/null 2>&1; then
		png2icns "${out}" "${WORK}/16.png" "${WORK}/32.png" "${WORK}/48.png" \
			"${WORK}/128.png" "${WORK}/256.png" "${WORK}/512.png" "${WORK}/1024.png"
	elif command -v python3 >/dev/null 2>&1; then
		python3 - "${out}" "${WORK}" <<-'PY'
			import struct
			import sys

			out, work = sys.argv[1], sys.argv[2]
			# PNG-encoded frames, the same set iconutil emits on modern macOS.
			frames = [
			    ('icp4', 16), ('icp5', 32), ('icp6', 64),
			    ('ic07', 128), ('ic08', 256), ('ic09', 512), ('ic10', 1024),
			    ('ic11', 32), ('ic12', 64), ('ic13', 256), ('ic14', 512),
			]
			chunks = []
			for kind, size in frames:
			    with open(f'{work}/{size}.png', 'rb') as handle:
			        data = handle.read()
			    chunks.append(kind.encode('ascii') + struct.pack('>I', 8 + len(data)) + data)
			body = b''.join(chunks)
			with open(out, 'wb') as handle:
			    handle.write(b'icns' + struct.pack('>I', 8 + len(body)) + body)
		PY
	else
		return 1
	fi
}

# Renders the logo onto an opaque white canvas for the Inno Setup wizard art.
build_bmp() {
	local width="$1" height="$2" scale="$3" out="$4" logo_size
	logo_size="$(awk -v w="${width}" -v h="${height}" -v s="${scale}" 'BEGIN { m = (w < h ? w : h); printf "%d", m * s }')"
	"${MAGICK[@]}" "${SOURCE}" -background none -alpha on -filter Lanczos \
		-resize "${logo_size}x${logo_size}" -fill '#1677ff' -colorize 100 \
		-strip "PNG32:${WORK}/bmp-logo.png"
	"${MAGICK[@]}" -size "${width}x${height}" xc:white "${WORK}/bmp-logo.png" \
		-gravity center -composite -type TrueColor -strip "BMP3:${out}"
}

# Wraps a PNG in a minimal SVG so the UI can keep loading a single .svg asset.
write_ui_svg() {
	local png="$1" outer="$2" extra="$3" out="$4"
	python3 - "${png}" "${outer}" "${extra}" "${out}" <<-'PY'
		import base64
		import pathlib
		import sys

		png, outer, extra, out = sys.argv[1:5]
		data = base64.b64encode(pathlib.Path(png).read_bytes()).decode('ascii')
		attributes = ['xmlns="http://www.w3.org/2000/svg"']
		if outer:
		    attributes += [f'width="{outer}"', f'height="{outer}"']
		attributes.append('viewBox="0 0 256 256"')
		if extra:
		    attributes.append(extra)
		svg = (
		    '<svg ' + ' '.join(attributes) + '>'
		    '<image width="256" height="256" href="data:image/png;base64,' + data + '"/>'
		    '</svg>\n'
		)
		pathlib.Path(out).write_text(svg, encoding='utf-8')
	PY
}

verify_ui_svgs() {
	local rel
	while IFS='|' read -r rel _ _ _; do
		[[ -n "${rel}" ]] || continue
		python3 - "${APP_DIR}/${rel}" <<-'PY' || die "${rel}: generated SVG is not a 256px PNG wrapper"
			import base64
			import re
			import sys
			import xml.etree.ElementTree as ET

			root = ET.parse(sys.argv[1]).getroot()
			image = root.find('{http://www.w3.org/2000/svg}image')
			if image is None:
			    sys.exit(1)
			href = image.get('href') or image.get('{http://www.w3.org/1999/xlink}href') or ''
			match = re.match(r'data:image/png;base64,(.+)$', href)
			if not match:
			    sys.exit(1)
			raw = base64.b64decode(match.group(1))
			if raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[16:24] != b'\x00\x00\x01\x00' * 2:
			    sys.exit(1)
		PY
	done <<<"${UI_ROWS}"
}

echo "Re-branding icons in ${APP_DIR#"${REPO_ROOT}"/}"
note "source: ${SOURCE} (${SOURCE_W}x${SOURCE_H}, ${SOURCE_FORMAT}, ${SOURCE_CHANNELS})"

SIZES=(1024 512 256 192 150 128 70 64 48 32 24 16)
for size in "${SIZES[@]}"; do
	render "${size}" "${WORK}/${size}.png"
done

"${MAGICK[@]}" "${WORK}/256.png" "${WORK}/128.png" "${WORK}/64.png" "${WORK}/48.png" \
	"${WORK}/32.png" "${WORK}/24.png" "${WORK}/16.png" "${WORK}/code.ico"
"${MAGICK[@]}" "${WORK}/48.png" "${WORK}/32.png" "${WORK}/16.png" "${WORK}/favicon.ico"
"${MAGICK[@]}" "${SOURCE}" -background none -alpha on -filter Lanczos \
	-resize 256x256! -colors 64 -strip "${WORK}/code.xpm"

echo
install_asset "${WORK}/1024.png" "${APP_DIR}/resources/linux/code.png"
install_asset "${WORK}/code.xpm" "${APP_DIR}/resources/linux/rpm/code.xpm"
install_asset "${WORK}/code.ico" "${APP_DIR}/resources/win32/code.ico"
install_asset "${WORK}/150.png" "${APP_DIR}/resources/win32/code_150x150.png"
install_asset "${WORK}/70.png" "${APP_DIR}/resources/win32/code_70x70.png"
install_asset "${WORK}/512.png" "${APP_DIR}/resources/server/code-512.png"
install_asset "${WORK}/192.png" "${APP_DIR}/resources/server/code-192.png"
install_asset "${WORK}/favicon.ico" "${APP_DIR}/resources/server/favicon.ico"

ICNS_OK=1
if ((SKIP_ICNS)); then
	note "skipping resources/darwin/code.icns (--skip-icns)"
elif build_icns "${WORK}/code.icns"; then
	install_asset "${WORK}/code.icns" "${APP_DIR}/resources/darwin/code.icns"
else
	ICNS_OK=0
	warn "resources/darwin/code.icns not rebuilt: install 'icnsutils' (png2icns) or run this on macOS"
fi

# The dev Electron bundle on macOS carries its own icon file. Keep it in sync so
# "npm run electron" launches show the product logo instead of Electron's.
if build_icns "${WORK}/code-dev.icns"; then
	install_asset "${WORK}/code-dev.icns" "${APP_DIR}/resources/darwin/code-dev-8bit.icns"
else
	warn "resources/darwin/code-dev-8bit.icns not rebuilt: install 'icnsutils' (png2icns) or run this on macOS"
fi

# Inno Setup draws these bitmaps in the Windows installer wizard.
INNO_BIG=(100:164x314 125:192x386 150:246x459 175:273x556 200:328x604 225:355x700 250:410x797)
INNO_SMALL=(100:55x55 125:64x68 150:83x80 175:92x97 200:110x106 225:119x123 250:138x140)
for entry in "${INNO_BIG[@]}"; do
	name="${entry%%:*}"; dims="${entry#*:}"
	build_bmp "${dims%x*}" "${dims#*x}" 0.62 "${WORK}/inno-big-${name}.bmp"
	install_asset "${WORK}/inno-big-${name}.bmp" "${APP_DIR}/resources/win32/inno-big-${name}.bmp"
done
for entry in "${INNO_SMALL[@]}"; do
	name="${entry%%:*}"; dims="${entry#*:}"
	build_bmp "${dims%x*}" "${dims#*x}" 0.78 "${WORK}/inno-small-${name}.bmp"
	install_asset "${WORK}/inno-small-${name}.bmp" "${APP_DIR}/resources/win32/inno-small-${name}.bmp"
done

DOCK_NAMES=(classic octopus peek terminal face)
if ((DOCK)); then
	for name in "${DOCK_NAMES[@]}"; do
		install_asset "${WORK}/1024.png" "${APP_DIR}/src/vs/code/electron-main/media/dock-${name}.png"
	done
fi

if ((IN_APP)); then
	command -v python3 >/dev/null 2>&1 || die "--in-app needs python3 to embed the raster logo into the UI SVGs"
	mkdir -p "${WORK}/ui"
	"${MAGICK[@]}" "${SOURCE}" -filter Lanczos -resize 256x256 -fill black -colorize 100 -strip "PNG32:${WORK}/ui-black.png"
	"${MAGICK[@]}" "${SOURCE}" -filter Lanczos -resize 256x256 -fill '#D9D9D9' -colorize 100 -strip "PNG32:${WORK}/ui-gray.png"
	"${MAGICK[@]}" "${SOURCE}" -filter Lanczos -resize 256x256 -fill '#1677ff' -colorize 100 -strip "PNG32:${WORK}/ui-blue.png"

	UI_ROWS="$(cat <<'ROWS'
src/vs/workbench/contrib/welcomeGettingStarted/browser/media/backboard_mark.svg|black||
src/vs/workbench/contrib/chat/browser/media/backboard_icon.svg|black||
src/vs/workbench/contrib/chat/browser/media/backboard_logo_blue.svg|blue||role="img" aria-label="DQuant Lab"
src/vs/sessions/browser/media/sessions-logo-light.svg|gray|128|
src/vs/sessions/browser/media/sessions-logo-dark.svg|black|128|
src/vs/sessions/browser/media/sessions-icon.svg|black|1024|
src/vs/workbench/browser/media/code-icon.svg|blue||
src/vs/sessions/browser/media/vscode-icon.svg|blue|96|
src/vs/workbench/contrib/chat/browser/widget/media/model-provider-icons/ai_backboard.svg|black||
src/vs/workbench/contrib/welcomeOnboarding/browser/media/model-provider-icons/ai_backboard.svg|black||
extensions/backboard/media/icons/backboard_logo.svg|black||
extensions/backboard/media/icons/backboard_agent.svg|black||
extensions/backboard/media/icons/backboard_agent_two.svg|black||
extensions/backboard/media/icons/backboard_assistant.svg|black||
extensions/backboard/media/icons/backboard_predict.svg|black||
extensions/backboard/media/icons/backboard_predict_up.svg|black||
extensions/backboard/media/icons/backboard_predict_down.svg|black||
extensions/backboard/media/icons/backboard_predict_error.svg|black||
extensions/backboard/media/icons/backboard_predict_disabled.svg|black||
extensions/backboard/media/icons/backboard_src_custom.svg|black||
extensions/backboard/media/icons/backboard_src_extension.svg|black||
extensions/backboard/media/icons/ai_backboard.svg|black||
extensions/backboard/media/ai_backboard.svg|black||
ROWS
)"

	ui_index=0
	while IFS='|' read -r rel variant outer extra; do
		[[ -n "${rel}" ]] || continue
		ui_index=$((ui_index + 1))
		ui_out="${WORK}/ui/${ui_index}.svg"
		write_ui_svg "${WORK}/ui-${variant}.png" "${outer}" "${extra}" "${ui_out}"
		install_asset "${ui_out}" "${APP_DIR}/${rel}"
		if [[ -f "${APP_DIR}/out/${rel#src/}" ]]; then
			install_asset "${ui_out}" "${APP_DIR}/out/${rel#src/}"
		fi
	done <<<"${UI_ROWS}"
fi

if ((DRY_RUN)); then
	echo
	note "dry run: nothing was written"
	exit 0
fi

echo
verify_dims "${APP_DIR}/resources/linux/code.png" 1024x1024
verify_dims "${APP_DIR}/resources/linux/rpm/code.xpm" 256x256
verify_ico_frames "${APP_DIR}/resources/win32/code.ico" 16 24 32 48 64 128 256
verify_dims "${APP_DIR}/resources/win32/code_150x150.png" 150x150
verify_dims "${APP_DIR}/resources/win32/code_70x70.png" 70x70
verify_dims "${APP_DIR}/resources/server/code-512.png" 512x512
verify_dims "${APP_DIR}/resources/server/code-192.png" 192x192
verify_ico_frames "${APP_DIR}/resources/server/favicon.ico" 16 32 48
if ((ICNS_OK)); then
	verify_icns "${APP_DIR}/resources/darwin/code.icns"
fi
verify_icns "${APP_DIR}/resources/darwin/code-dev-8bit.icns"
for entry in "${INNO_BIG[@]}"; do
	name="${entry%%:*}"; dims="${entry#*:}"
	verify_dims "${APP_DIR}/resources/win32/inno-big-${name}.bmp" "${dims}"
done
for entry in "${INNO_SMALL[@]}"; do
	name="${entry%%:*}"; dims="${entry#*:}"
	verify_dims "${APP_DIR}/resources/win32/inno-small-${name}.bmp" "${dims}"
done
if ((DOCK)); then
	for name in "${DOCK_NAMES[@]}"; do
		verify_dims "${APP_DIR}/src/vs/code/electron-main/media/dock-${name}.png" 1024x1024
	done
fi
if ((IN_APP)); then
	verify_ui_svgs
fi
echo "All generated assets verified."

if ((IN_APP)); then
	cat <<EOF

In-app UI logos were rebuilt from the same source (256px PNG inside SVG):
  black      backboard_mark.svg, backboard_icon.svg, sessions-logo-dark.svg,
             sessions-icon.svg, model-provider-icons/ai_backboard.svg (x2),
             extensions/backboard/media/icons/*.svg
  #D9D9D9    sessions-logo-light.svg
  #1677ff    backboard_logo_blue.svg, code-icon.svg, vscode-icon.svg

Windows/macOS packaging assets were rebuilt too:
  resources/win32/inno-{big,small}-*.bmp, resources/darwin/code-dev-8bit.icns

Next steps:
  * dev app: restart it (on macOS preLaunch copies code.icns into .build/electron)
    and run Developer: Reload Window for the new UI logos
  * installers: rebuild the .dmg/.exe/.deb/.rpm so the new icons get packaged
  * review the diff: git -C "${REPO_ROOT}" status --short
EOF
else
	cat <<EOF

Not touched on purpose (rerun with --in-app to rebuild them too):
  backboard/src/vs/workbench/contrib/welcomeGettingStarted/browser/media/backboard_mark.svg
  backboard/src/vs/workbench/contrib/chat/browser/media/backboard_icon.svg
  backboard/src/vs/workbench/contrib/chat/browser/media/backboard_logo_blue.svg
  backboard/src/vs/sessions/browser/media/sessions-logo-light.svg
  backboard/src/vs/sessions/browser/media/sessions-logo-dark.svg
  backboard/src/vs/sessions/browser/media/sessions-icon.svg
  backboard/src/vs/workbench/contrib/chat/browser/widget/media/model-provider-icons/ai_backboard.svg
  backboard/src/vs/workbench/contrib/welcomeOnboarding/browser/media/model-provider-icons/ai_backboard.svg
  backboard/src/vs/workbench/browser/media/code-icon.svg
  backboard/src/vs/sessions/browser/media/vscode-icon.svg
  backboard/extensions/backboard/media/icons/{backboard_logo,backboard_agent,backboard_agent_two,backboard_assistant,ai_backboard}.svg
  backboard/extensions/backboard/media/ai_backboard.svg

Next steps:
  * dev app: restart it (on macOS preLaunch copies code.icns into .build/electron)
  * installers: rebuild the .dmg/.exe/.deb/.rpm so the new icons get packaged
  * review the diff: git -C "${REPO_ROOT}" status --short
EOF
fi
