document.addEventListener("DOMContentLoaded", () => {
  ["", "2"].forEach(suffix => {
    let videoRecorder
    const recordingMessage = document.getElementById("recodingMessage" + suffix)
    const videoDevices = document.getElementById("videoDevices" + suffix)
    const audioDevices = document.getElementById("audioDevices" + suffix)
    const recordingSizeMB = document.getElementById("recordingSizeMB" + suffix)
    const remainedSizeMB = document.getElementById("remainingSizeMB" + suffix)
    const logTextArea = document.getElementById("logTextArea" + suffix)
    const logClearButton = document.getElementById("logClearButton" + suffix)
    MyVideoRecorder.init({
      selector: "#video" + suffix,
      messageForUnsupported: "お使いのブラウザは動画再生に対応していません。",
      logTextArea
    }).then(vr => {
      videoRecorder = vr
      // 初期状態でデバイス一覧を取得して先頭を選択状態にしておく
      updateDevices()
    })
    document.getElementById("startPreview" + suffix).addEventListener("click", async () => {
      const loadingMessage = document.getElementById("loadingMessage" + suffix)
      loadingMessage.style.display = ""
      const success = await videoRecorder.startPreview()
      loadingMessage.style.display = "none"
      if (!success) {
        alert("カメラとマイクのアクセスを許可してください。");
        return
      }
    })
    // プレビュー停止
    document.getElementById("stopPreview" + suffix).addEventListener("click", async () => {
      videoRecorder.stopPreview()
    })
    // 録画開始
    document.getElementById("startRecording" + suffix).addEventListener("click", () => {
      const maxSize = 2_000_000;  // とりあえず2MB制限
      const toMB = (value) => Math.max(0, (value / 1000_000)).toFixed(2)
      recordingSizeMB.innerHTML = toMB(0)
      remainedSizeMB.innerHTML = toMB(maxSize)
      videoRecorder.startRecording({
        async onProcess({ totalSize }) {
          recordingSizeMB.innerHTML = toMB(totalSize)
          remainedSizeMB.innerHTML = toMB(maxSize - totalSize)
          if (totalSize > maxSize) {
            await stopRecordingAndShowPreview()
            alert("既定のサイズを超えたため録画終了しました")
          }
        }
      })
      recordingMessage.style.display = ""
    })
    // 録画終了
    document.getElementById("stopRecording" + suffix).addEventListener("click", async () => {
      stopRecordingAndShowPreview()
    })

    // デバイス取得ボタン
    document.getElementById("getAvailableDevices" + suffix).addEventListener("click", async () => {
      updateDevices()
    })
    logClearButton.addEventListener("click", () => logTextArea.value = "")
    // デバイス一覧
    const updateDevices = async () => {
      const devices = await videoRecorder.getAvailableDevices()
      const refresh = (selectElem, devices) => {
        selectElem.innerHTML = ""
        devices.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.text = d.label;
          selectElem.appendChild(opt);
        })
      }
      refresh(audioDevices, devices.audioDevices)
      refresh(videoDevices, devices.videoDevices)
      videoRecorder.videoDevice = videoDevices.value
      videoRecorder.audioDevice = audioDevices.value
    }
    audioDevices.addEventListener("change", () => {
      console.log(videoRecorder)
      videoRecorder.audioDevice = audioDevices.value
    })
    videoDevices.addEventListener("change", () => {
      console.log(videoRecorder)
      videoRecorder.videoDevice = videoDevices.value
    })

    const stopRecordingAndShowPreview = async () => {
      const { blob, mimeType } = await videoRecorder.stopRecording()
      recordingMessage.style.display = "none"
      if (!blob) { return }
      // ファイル名を設定する
      const now = new Date();
      // const timestamp = now.getTime();
      const localDate = now.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-");
      const localTime = now.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(/:/g, "-");
      const randomStr = Math.random().toString(36).substring(2, 8);
      const fileExtension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
      const fileName = `video_${localDate}_${localTime}_${randomStr}.${fileExtension}`;

      // 録画ファイルの作成
      const file = new File([blob], fileName, { type: mimeType });
      document.getElementById("videoPreview" + suffix).src = URL.createObjectURL(file)
    }
  })
})
