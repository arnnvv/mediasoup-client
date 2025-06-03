import { io, type Socket } from "socket.io-client";
import {
  type Transport,
  type RtpCapabilities as ClientRtpCapabilities,
  Device,
  type Producer,
  type Consumer,
  type DtlsParameters,
  type RtpParameters,
  type TransportOptions,
} from "mediasoup-client/types";
import type {
  RtpCapabilitiesResponse,
  CreateTransportResponse,
  ProduceResponse,
  ConsumeResponse,
  NewProducerData,
  ExistingProducersData,
  ProducerClosedData,
  ConsumerClosedData,
  ConnectionSuccessData,
} from "./types";

let socket: Socket;
let device: Device;
let rtpCapabilities: ClientRtpCapabilities;
let producerTransport: Transport | null = null;
let videoProducer: Producer | null = null;
let audioProducer: Producer | null = null;
let consumerTransport: Transport | null = null;
const consumers = new Map<string, Consumer>();
let localStream: MediaStream | null = null;

const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement;
const remoteAudio = document.getElementById("remoteAudio") as HTMLAudioElement;
const btnStartStreaming = document.getElementById(
  "btnStartStreaming",
) as HTMLButtonElement;

const videoParams = {
  encodings: [
    { rid: "r0", maxBitrate: 100000, scalabilityMode: "S1T3" },
    { rid: "r1", maxBitrate: 300000, scalabilityMode: "S1T3" },
    { rid: "r2", maxBitrate: 900000, scalabilityMode: "S1T3" },
  ],
  codecOptions: {
    videoGoogleStartBitrate: 1000,
  },
};

async function initSocket() {
  socket = io("wss://localhost:3000/mediasoup", {
    secure: false,
    rejectUnauthorized: false,
  });

  socket.on("connection-success", (data: ConnectionSuccessData) => {
    console.log("Connected to Mediasoup server with socket ID:", data.socketId);
  });

  socket.on("connect_error", (error) => {
    console.error("Socket connection error:", error);
    alert(
      `Failed to connect to signaling server: ${error.message}. Please ensure server is running and accessible.`,
    );
    btnStartStreaming.disabled = true;
  });

  socket.on("disconnect", () => {
    console.warn("Disconnected from Mediasoup server");
    if (videoProducer) videoProducer.close();
    if (audioProducer) audioProducer.close();
    if (producerTransport) producerTransport.close();
    consumers.forEach((c) => c.close());
    if (consumerTransport) consumerTransport.close();

    videoProducer = null;
    audioProducer = null;
    producerTransport = null;
    consumers.clear();
    consumerTransport = null;
    remoteVideo.srcObject = null;
    remoteAudio.srcObject = null;
    btnStartStreaming.textContent = "Start Streaming";
    btnStartStreaming.disabled = false;
  });

  socket.on("new-producer", async (data: NewProducerData) => {
    console.log("New producer available:", data);
    if (data.producerSocketId === socket.id) {
      console.log("Ignoring self-produced stream.");
      return;
    }

    if (!consumers.has(data.producerId)) {
      await consumeStream(data.producerId);
    }
  });

  socket.on("producer-closed", (data: ProducerClosedData) => {
    console.log(`Producer ${data.producerId} closed on server.`);
    const consumer = consumers.get(data.producerId);
    if (consumer) {
      consumer.close();
      consumers.delete(data.producerId);

      if (
        consumer.kind === "video" &&
        remoteVideo.srcObject &&
        (remoteVideo.srcObject as MediaStream)
          .getTracks()
          .some((t) => t.id === consumer.track.id)
      ) {
        remoteVideo.srcObject = null;
        console.log("Remote video cleared because producer closed.");
      }

      if (
        consumer.kind === "audio" &&
        remoteAudio.srcObject &&
        (remoteAudio.srcObject as MediaStream)
          .getTracks()
          .some((t) => t.id === consumer.track.id)
      ) {
        remoteAudio.srcObject = null;
        console.log("Remote audio cleared because producer closed.");
      }
    }
  });

  socket.on("existing-producers", async (data: ExistingProducersData) => {
    console.log("Received existing producers:", data.producers);
    for (const producerInfo of data.producers) {
      if (producerInfo.producerSocketId === socket.id) {
        console.log("Ignoring self as existing producer.");
        continue;
      }

      if (!consumers.has(producerInfo.producerId)) {
        console.log(
          `Found existing ${producerInfo.kind} producer to consume: ${producerInfo.producerId}`,
        );
        await consumeStream(producerInfo.producerId);
      }
    }
  });

  socket.on("consumer-closed", (data: ConsumerClosedData) => {
    console.log(
      `Consumer ${data.consumerId} (for producer ${data.producerId}) closed by server.`,
    );
    const consumer = consumers.get(data.producerId);
    if (consumer && consumer.id === data.consumerId) {
      consumers.delete(data.producerId);

      if (
        consumer.kind === "video" &&
        remoteVideo.srcObject &&
        (remoteVideo.srcObject as MediaStream)
          .getTracks()
          .some((t) => t.id === consumer.track.id)
      ) {
        remoteVideo.srcObject = null;
        console.log("Remote video cleared because consumer closed.");
      }

      if (
        consumer.kind === "audio" &&
        remoteAudio.srcObject &&
        (remoteAudio.srcObject as MediaStream)
          .getTracks()
          .some((t) => t.id === consumer.track.id)
      ) {
        remoteAudio.srcObject = null;
        console.log("Remote audio cleared because consumer closed.");
      }
    }
  });
}

async function getLocalVideo(): Promise<MediaStream | null> {
  console.log("Requesting local audio/video stream...");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
    localVideo.srcObject = stream;
    localStream = stream;
    console.log("Local audio/video stream acquired.");
    return stream;
  } catch (error) {
    console.error("Error getting local media:", error);
    alert(
      "Could not access your camera and microphone. Please check permissions.",
    );
    return null;
  }
}

async function loadDevice() {
  if (device && device.loaded) {
    console.log("Device already loaded.");
    return;
  }

  try {
    rtpCapabilities = await new Promise<ClientRtpCapabilities>(
      (resolve, reject) => {
        socket.emit("getRtpCapabilities", (data: RtpCapabilitiesResponse) => {
          if (!data || !data.rtpCapabilities) {
            reject(new Error("Failed to get RTP capabilities from server."));
            return;
          }

          console.log("Router RTP Capabilities:", data.rtpCapabilities);
          resolve(data.rtpCapabilities);
        });
      },
    );

    device = new Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    console.log("Mediasoup device loaded successfully.");
    console.log("Device RTP Capabilities:", device.rtpCapabilities);
  } catch (error) {
    console.error("Error loading Mediasoup device:", error);
    if (error instanceof Error && error.name === "UnsupportedError") {
      alert("Browser not supported for WebRTC.");
    }
    throw error;
  }
}

async function createSendTransport() {
  console.log("Creating send transport...");
  const transportParams = await new Promise<TransportOptions>(
    (resolve, reject) => {
      socket.emit(
        "createWebRtcTransport",
        { sender: true },
        (response: CreateTransportResponse) => {
          if (response.error) {
            reject(new Error(response.error));
            return;
          }

          if (!response.params) {
            reject(new Error("No transport params received"));
            return;
          }

          console.log("Send transport params from server:", response.params);
          resolve(response.params);
        },
      );
    },
  );

  producerTransport = device.createSendTransport(transportParams);

  producerTransport.on(
    "connect",
    async (
      { dtlsParameters }: { dtlsParameters: DtlsParameters },
      callback,
      errback,
    ) => {
      console.log("Send transport 'connect' event");
      try {
        socket.emit("transport-connect", {
          transportId: producerTransport!.id,
          dtlsParameters,
        });
        callback();
      } catch (error) {
        errback(error as Error);
      }
    },
  );

  producerTransport.on(
    "produce",
    async (
      {
        kind,
        rtpParameters,
        appData,
      }: { kind: string; rtpParameters: RtpParameters; appData: any },
      callback,
      errback,
    ) => {
      console.log("Send transport 'produce' event for kind:", kind);
      try {
        socket.emit(
          "transport-produce",
          {
            transportId: producerTransport!.id,
            kind,
            rtpParameters,
            appData,
          },
          (response: ProduceResponse) => {
            if (response.error) {
              errback(new Error(response.error));
              return;
            }

            if (!response.id) {
              errback(new Error("Server did not return a producer id"));
              return;
            }

            callback({ id: response.id });
            console.log(
              `Successfully produced ${kind} with server-side id: ${response.id}`,
            );
          },
        );
      } catch (error) {
        errback(error as Error);
      }
    },
  );

  producerTransport.on("connectionstatechange", (state) => {
    console.log(`Send transport connection state: ${state}`);
    if (state === "failed" || state === "closed") {
      console.error("Send transport connection failed or closed.");
    }
  });

  console.log("Send transport created.");
}

async function startProducingVideo() {
  if (!localStream || !producerTransport) {
    console.error("Local stream or producer transport not ready.");
    return;
  }

  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) {
    console.error("No video track found in local stream.");
    return;
  }

  try {
    console.log("Starting to produce video...");
    videoProducer = await producerTransport.produce({
      track: videoTrack,
      ...videoParams,
      appData: { mediaTag: "cam-video" },
    });

    videoProducer.on("trackended", () => {
      console.warn("Video producer track ended (e.g., camera unplugged).");
      stopStreaming();
    });

    videoProducer.on("transportclose", () => {
      console.warn("Video producer transport closed.");
      videoProducer = null;
    });

    console.log("Video producer created, ID:", videoProducer.id);
  } catch (error) {
    console.error("Error producing video:", error);
    alert("Failed to start video production.");
  }
}

async function startProducingAudio() {
  if (!localStream || !producerTransport) {
    console.error("Local stream or producer transport not ready.");
    return;
  }

  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) {
    console.error("No audio track found in local stream.");
    return;
  }

  try {
    console.log("Starting to produce audio...");
    audioProducer = await producerTransport.produce({
      track: audioTrack,
      appData: { mediaTag: "mic-audio" },
    });

    audioProducer.on("trackended", () => {
      console.warn("Audio producer track ended.");
    });

    audioProducer.on("transportclose", () => {
      console.warn("Audio producer transport closed.");
      audioProducer = null;
    });

    console.log("Audio producer created, ID:", audioProducer.id);
  } catch (error) {
    console.error("Error producing audio:", error);
    alert("Failed to start audio production.");
  }
}

async function createRecvTransport() {
  console.log("Creating receive transport...");
  const transportParams = await new Promise<TransportOptions>(
    (resolve, reject) => {
      socket.emit(
        "createWebRtcTransport",
        { sender: false },
        (response: CreateTransportResponse) => {
          if (response.error) {
            reject(new Error(response.error));
            return;
          }

          if (!response.params) {
            reject(new Error("No transport params received"));
            return;
          }

          console.log("Receive transport params from server:", response.params);
          resolve(response.params);
        },
      );
    },
  );

  consumerTransport = device.createRecvTransport(transportParams);

  consumerTransport.on(
    "connect",
    async (
      { dtlsParameters }: { dtlsParameters: DtlsParameters },
      callback,
      errback,
    ) => {
      console.log("Receive transport 'connect' event");
      try {
        socket.emit("transport-connect", {
          transportId: consumerTransport!.id,
          dtlsParameters,
        });
        callback();
      } catch (error) {
        errback(error as Error);
      }
    },
  );

  consumerTransport.on("connectionstatechange", (state) => {
    console.log(`Receive transport connection state: ${state}`);
    if (state === "failed" || state === "closed") {
      console.error("Receive transport connection failed or closed.");
    }
  });

  console.log("Receive transport created.");
}

async function consumeStream(producerIdToConsume: string) {
  if (!consumerTransport || !device.loaded || !device.rtpCapabilities) {
    console.error("Consumer transport or device not ready for consuming.");
    return;
  }

  if (consumers.has(producerIdToConsume)) {
    console.log(`Already consuming producer ${producerIdToConsume}`);
    return;
  }

  console.log(`Requesting to consume producer: ${producerIdToConsume}`);
  const consumerParams = await new Promise<ConsumeResponse["params"]>(
    (resolve, reject) => {
      socket.emit(
        "consume",
        {
          consumerTransportId: consumerTransport!.id,
          producerId: producerIdToConsume,
          rtpCapabilities: device.rtpCapabilities,
        },
        (response: ConsumeResponse) => {
          if (response.error) {
            reject(new Error(`Error consuming: ${response.error}`));
            return;
          }

          if (!response.params) {
            reject(new Error("No params received for consumer"));
            return;
          }

          console.log("Consumer params from server:", response.params);
          resolve(response.params);
        },
      );
    },
  );

  if (!consumerParams) {
    console.error("No consumer params received");
    return;
  }

  try {
    const consumer = await consumerTransport.consume({
      id: consumerParams.id,
      producerId: consumerParams.producerId,
      kind: consumerParams.kind,
      rtpParameters: consumerParams.rtpParameters,
    });

    consumers.set(consumer.producerId, consumer);
    console.log(
      `Consumer created for producer ${consumer.producerId}, ID: ${consumer.id}, Kind: ${consumer.kind}`,
    );

    consumer.on("transportclose", () => {
      console.warn(
        `Consumer's transport closed for producer ${consumer.producerId}`,
      );
      consumers.delete(consumer.producerId);
    });

    consumer.on("transportclose", () => {
      console.warn(`Producer for consumer ${consumer.id} closed.`);
      consumer.close();
      consumers.delete(consumer.producerId);

      if (
        consumer.kind === "video" &&
        remoteVideo.srcObject &&
        (remoteVideo.srcObject as MediaStream)
          .getTracks()
          .some((t) => t.id === consumer.track.id)
      ) {
        remoteVideo.srcObject = null;
        console.log("Remote video cleared on producerclose for consumer.");
      }

      if (
        consumer.kind === "audio" &&
        remoteAudio.srcObject &&
        (remoteAudio.srcObject as MediaStream)
          .getTracks()
          .some((t) => t.id === consumer.track.id)
      ) {
        remoteAudio.srcObject = null;
        console.log("Remote audio cleared on producerclose for consumer.");
      }
    });

    if (consumer.kind === "video") {
      if (!remoteVideo.srcObject) {
        const stream = new MediaStream();
        stream.addTrack(consumer.track);
        remoteVideo.srcObject = stream;
        console.log("Remote video stream set up.");
      } else {
        (remoteVideo.srcObject as MediaStream).addTrack(consumer.track);
        console.log("Added video track to existing remote stream.");
      }
    }

    if (consumer.kind === "audio") {
      if (!remoteAudio.srcObject) {
        const audioStream = new MediaStream();
        audioStream.addTrack(consumer.track);
        remoteAudio.srcObject = audioStream;
        console.log("Remote audio stream set up.");
      } else {
        (remoteAudio.srcObject as MediaStream).addTrack(consumer.track);
        console.log("Added audio track to existing remote stream.");
      }
    }

    socket.emit("consumer-resume", { consumerId: consumer.id });
    console.log(`Resumed consumer ${consumer.id} on server.`);
  } catch (error) {
    console.error(
      `Error creating/consuming stream for producer ${producerIdToConsume}:`,
      error,
    );
    alert(`Failed to consume stream: ${(error as Error).message}`);
  }
}

async function startStreaming() {
  btnStartStreaming.disabled = true;
  btnStartStreaming.textContent = "Starting...";
  try {
    if (!socket || !socket.connected) {
      console.log("Socket not connected. Initializing...");
      await initSocket();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!socket.connected) {
        throw new Error("Failed to connect to signaling server after init.");
      }
    }

    if (!localStream) {
      await getLocalVideo();
      if (!localStream) throw new Error("Failed to get local media.");
    }

    if (!device || !device.loaded) {
      await loadDevice();
    }

    if (!producerTransport || producerTransport.closed) {
      await createSendTransport();
    }

    if (!consumerTransport || consumerTransport.closed) {
      await createRecvTransport();
    }

    if (!videoProducer || videoProducer.closed) {
      await startProducingVideo();
    }

    if (!audioProducer || audioProducer.closed) {
      await startProducingAudio();
    }

    if (
      (videoProducer && !videoProducer.closed) ||
      (audioProducer && !audioProducer.closed)
    ) {
      btnStartStreaming.textContent = "Stop Streaming";
    } else {
      btnStartStreaming.textContent = "Start Streaming";
    }
  } catch (error) {
    console.error("Error during startStreaming:", error);
    alert(`Could not start streaming: ${(error as Error).message}`);
    btnStartStreaming.textContent = "Start Streaming";
  } finally {
    if (
      (videoProducer && !videoProducer.closed) ||
      (audioProducer && !audioProducer.closed) ||
      btnStartStreaming.textContent === "Start Streaming"
    ) {
      btnStartStreaming.disabled = false;
    }
  }
}

function stopStreaming() {
  console.log("Stopping streams...");
  btnStartStreaming.disabled = true;

  if (videoProducer) {
    videoProducer.close();
    videoProducer = null;
  }

  if (audioProducer) {
    audioProducer.close();
    audioProducer = null;
  }

  if (producerTransport) {
    producerTransport.close();
    producerTransport = null;
  }

  consumers.forEach((consumer) => consumer.close());
  consumers.clear();

  if (consumerTransport) {
    consumerTransport.close();
    consumerTransport = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    localVideo.srcObject = null;
  }

  remoteVideo.srcObject = null;
  remoteAudio.srcObject = null;

  btnStartStreaming.textContent = "Start Streaming";
  btnStartStreaming.disabled = false;
  console.log("Streaming stopped.");
}

btnStartStreaming.addEventListener("click", () => {
  if (btnStartStreaming.textContent === "Start Streaming") {
    startStreaming();
  } else {
    stopStreaming();
  }
});

console.log("Client script loaded. Click 'Start Streaming' to begin.");
