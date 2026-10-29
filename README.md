# Drone camera

Shared local mod/package for WebGPU still capture, JPEG EXIF/XMP, optical flow, spherical sequencing and zip export. Camera model mods supply sensor/lens/metadata profiles; airframe mods supply gimbal mount limits. Fly owns scene lifecycle, flight state and pilot commands. No imports point back to fly. The capture implementation loads only through the applied drone feature; `jpeg-js` is imported only at the shutter.

No repository has been created or published.

Capture chooses the loaded scene for the sensor view, accepts a host visibility predicate, submits WebGPU draw commands before direct reads, and normalizes render-target rows for JPEG and optical flow. Target aspect changes apply only to the sensor projection. The local browser-safe `jpeg-js` fork remains the encoder; no polyfill or WebGL path is needed.

`sensorFrame` is the optional live-view transport: `createSensorPreviewRig` reads upright packed RGBA frames from the selected camera and lens, at up to 640 pixels wide with the sensor's aspect ratio. It shares offscreen rendering and WebGPU readback with still capture, without loading JPEG or optical flow. A host controls when frames are requested and must dispose the rig when changing scenes; overlapping reads are refused and disposal cancels a pending read. Preview presentation belongs to a separate provider mod.

`cameraControls` exports a reusable DOM panel for manual gimbal pitch, still capture, and starting/stopping a 360 sequence. The host supplies model identity, mount limits, actual/target angles, capture progress, pause and error state through `update`, and receives commands through callbacks. It imports shared UI factories but no capture, JPEG, optical-flow or flight runtime. The host owns mounting and must retain the panel while switching tabs; detaching it does not reset camera state.

The optional Roll/Yaw controls use the same bounded-axis UI as Pitch: host-supplied target/actual angles and limits, 5° nudges and zero reset. Camera metadata accepts actual gimbal yaw and roll in addition to pitch; omitted legacy values remain aircraft heading and zero roll.

The optional `0SFS/camera-preview` display is a separate mod/repository. `cameraControls` accepts a host-owned preview element and imports no preview implementation. Preview providers consume the versioned `@0sfs/mods/cameraPreview` contract, so the host does not depend on a particular display package. Sensor selection remains the airframe's `quad.cameraId` and camera-model dependency.

The panel surrounds that central preview with Roll above, Yaw below and vertical Pitch on the right. The host may bind shared 360-viewer gestures to a provider canvas. `SensorPreviewRig.read` accepts an optional narrower vertical FOV for preview magnification; rendering restores the shared camera's lens/projection before asynchronous readback, so still capture retains its native sensor view.
