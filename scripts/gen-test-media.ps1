<#
.SYNOPSIS
    Generates synthetic test media with FFmpeg lavfi sources (docs/MEDIA-PIPELINE.md §8,
    docs/ROADMAP.md Phase 3). Test media is generated, never committed as binaries.

.DESCRIPTION
    Produces one file per case the media pipeline needs to handle correctly: constant and
    variable frame rate, a rotated (phone-style) video, an HDR-tagged stream, audio-only,
    a still image, an animated image, and a file with a Devanagari name (Hindi/Hinglish
    content is a stated product requirement, docs/ARCHITECTURE.md).

.PARAMETER OutDir
    Where to write the generated files. Defaults to `.media-fixtures/` at the repo root,
    which is gitignored — these files are never committed.

.EXAMPLE
    ./scripts/gen-test-media.ps1
    ./scripts/gen-test-media.ps1 -OutDir D:\scratch\kriti-media
#>
param(
    [string]$OutDir = (Join-Path $PSScriptRoot '..\.media-fixtures')
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Output "Generating test media into $OutDir"

function Invoke-Ffmpeg {
    param([string[]]$Args)
    & ffmpeg -y -v error @Args
    if ($LASTEXITCODE -ne 0) {
        throw "ffmpeg failed (exit $LASTEXITCODE): $($Args -join ' ')"
    }
}

# Constant frame rate, H.264/AAC, 1080p — the common case.
Invoke-Ffmpeg @(
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:duration=3:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    (Join-Path $OutDir 'cfr_1080p30.mp4')
)

# Variable frame rate, matching screen-recording software (docs/MEDIA-PIPELINE.md §3.3).
Invoke-Ffmpeg @(
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:duration=3:rate=60',
    '-vf', 'fps=fps=60:round=up,setpts=if(mod(N\,7),PTS+0.5/TB,PTS)',
    '-vsync', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    (Join-Path $OutDir 'vfr_screen_recording.mp4')
)

# Rotated 90°, matching a phone shot in portrait (docs/MEDIA-PIPELINE.md §3.4).
Invoke-Ffmpeg @(
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:duration=2:rate=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata:s:v:0', 'rotate=90',
    (Join-Path $OutDir 'rotated_90.mp4')
)

# HDR-tagged (PQ transfer function) — docs/MEDIA-PIPELINE.md §3.4's HDR-to-SDR case.
Invoke-Ffmpeg @(
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:duration=2:rate=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le',
    '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
    (Join-Path $OutDir 'hdr_pq.mp4')
)

# Audio-only.
Invoke-Ffmpeg @(
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4',
    '-c:a', 'mp3',
    (Join-Path $OutDir 'audio_only.mp3')
)

# Still image.
Invoke-Ffmpeg @(
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080', '-frames:v', '1',
    (Join-Path $OutDir 'still_image.png')
)

# Animated image (docs/MEDIA-PIPELINE.md §2.1: animated WebP/GIF must classify as video).
Invoke-Ffmpeg @(
    '-f', 'lavfi', '-i', 'testsrc2=size=480x270:duration=2:rate=10',
    (Join-Path $OutDir 'animated.gif')
)

# Devanagari file name (docs/MEDIA-PIPELINE.md §8: Unicode paths, Hindi/Hinglish content).
Invoke-Ffmpeg @(
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:duration=2:rate=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    (Join-Path $OutDir 'समाचार क्लिप.mp4')
)

Write-Output 'Done.'
Get-ChildItem $OutDir | Select-Object Name, @{n='KB';e={[math]::Round($_.Length/1KB,1)}}
