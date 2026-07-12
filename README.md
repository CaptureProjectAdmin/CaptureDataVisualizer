# Capture App Visualizer

A local web app for reviewing [Sensor Logger](https://www.tszheichoi.com/sensor-logger) recordings from the CAPTURE project. It synchronizes sensor CSV data, video, audio, and GPS on a shared timeline so you can scrub through naturalistic walk sessions and inspect selected sensors side by side.

## Features

- Synchronized playback of sensor data, video, and audio
- Selectable sensor charts (accelerometer, gyroscope, orientation, microphone, etc.)
- GPS track map with moving position marker
- Separate video and audio support (including `.mp4` for both camera and microphone)
- Video rotation in 90° steps (picture only; controls stay upright)
- Load recordings from the default `Data/` folder or any path on your machine

## Requirements

- **Python 3.10+** (3.11 or 3.12 recommended)
- A modern web browser (Chrome, Edge, or Firefox)
- Internet connection on first load (for Leaflet map tiles and uPlot chart library from CDN)

## Installation on a new computer

### 1. Clone or copy the repository

```bat
git clone <your-repo-url> D:\GithubReps\Capture\CaptureDataVisualizer
cd D:\GithubReps\Capture\CaptureDataVisualizer
```

Or copy the project folder to the machine without git.

### 2. Install Python

If Python is not installed:

1. Download from [python.org](https://www.python.org/downloads/)
2. During setup, check **“Add python.exe to PATH”**
3. Verify in a terminal:

```bat
python --version
pip --version
```

### 3. Install Python dependencies

From the project root:

```bat
python -m pip install -r requirements.txt
```

Optional: use a virtual environment:

```bat
python -m venv .venv
.venv\Scripts\activate
python -m pip install -r requirements.txt
```

### 4. Add your recording data

**Recording data is not included in this repository.** Place your Sensor Logger export in the `Data/` folder.

Export from Sensor Logger as **Zipped CSV** (recommended — includes all sensors and media), then unzip into `Data/`:

```
CaptureDataVisualizer/
├── Data/
│   ├── Metadata.csv
│   ├── Accelerometer.csv
│   ├── Gyroscope.csv
│   ├── Location.csv
│   ├── Microphone.csv
│   ├── Camera.mp4          ← video (if recorded)
│   ├── Microphone.mp4      ← audio (if recorded)
│   └── ...other CSVs...
├── server.py
├── start.bat
└── static/
```

You can also point the app at any folder using the **Data folder** field in the UI (relative path from the project root, or an absolute path).

## Running the app

### Windows (easiest)

Double-click **`start.bat`**. It will:

1. Install/update Python dependencies
2. Start the server at `http://127.0.0.1:8765`
3. Open your default browser automatically

### Manual start

```bat
cd D:\GithubReps\Capture\CaptureDataVisualizer
python -m uvicorn server:app --host 127.0.0.1 --port 8765
```

Then open **http://127.0.0.1:8765** in your browser.

Press `Ctrl+C` in the terminal to stop the server.

## How to use

1. **Start the app** with `start.bat` or the manual command above.
2. **Load data**
   - If files are in `Data/`, the app loads them automatically on startup.
   - Otherwise, enter a folder path in **Data folder** and click **Load**.
3. **Select sensors** in the left sidebar (checkboxes). Use **All** / **None** to toggle quickly.
4. **Playback**
   - Use the bottom transport bar or the video control bar to scrub and play/pause.
   - Adjust playback speed (0.25×–4×) from the bottom bar.
5. **Video**
   - Use **↺ 90°** / **↻ 90°** to rotate the picture if the recording is sideways.
   - Rotation is saved in your browser for the next session.
6. **Charts and map** update in real time as you move the playhead. GPS appears when **Location** is selected.

## Supported data formats

| Type | Formats |
|------|---------|
| Sensors | Sensor Logger CSV exports (`*.csv` with `seconds_elapsed` column) |
| Video | `.mp4`, `.mov`, `.webm`, `.mkv`, `.m4v` |
| Audio | `.mp4`, `.m4a`, `.wav`, `.aac`, `.ogg`, `.mp3`, `.flac` |
| Camera stills | `Camera.csv` + image files in `images/` |

Filenames containing `camera` or `video` are treated as video; `microphone`, `mic`, or `audio` as audio.

## Project structure

```
CaptureDataVisualizer/
├── Data/              ← put recordings here (git-ignored)
├── static/
│   ├── index.html     ← UI layout
│   ├── app.js         ← playback, charts, sync logic
│   └── styles.css
├── server.py          ← FastAPI backend
├── requirements.txt   ← Python dependencies
├── start.bat          ← Windows launcher
└── README.md
```

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| `python` not found | Reinstall Python with “Add to PATH”, or use `py -3` instead of `python` |
| Port 8765 in use | Change the port: `python -m uvicorn server:app --host 127.0.0.1 --port 8766` |
| No sensors shown | Ensure CSV files are in the folder and include `Metadata.csv` |
| Video/audio missing | Use the full Zipped CSV export from Sensor Logger, not CSV-only export |
| Browser does not open | Manually visit `http://127.0.0.1:8765` |

## License

Internal CAPTURE project tool. Sensor Logger data format is documented at [awesome-sensor-logger](https://github.com/tszheichoi/awesome-sensor-logger).
