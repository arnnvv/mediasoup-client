import { io } from "socket.io-client";
import {
  type Transport,
  type RtpCapabilities,
  Device,
  type Producer,
  type Consumer,
} from "mediasoup-client/types";

let rtpCapabilities: RtpCapabilities;
let device: Device;
let producer: Producer;
let producerTransport: Transport;
let consumer: Consumer;
let consumerTransport: Transport;

const socket = io("wss://localhost:3000/mediasoup");

socket.on("connection-success", ({ socketId }) => {
  console.log(socketId);
});

const localVideo = document.getElementById("localVideo") as HTMLVideoElement;
const remoteVideo = document.getElementById("remoteVideo") as HTMLVideoElement;
const btnLocalVideo = document.getElementById(
  "btnLocalVideo",
) as HTMLButtonElement;
const btnRtpCapabilities = document.getElementById(
  "btnRtpCapabilities",
) as HTMLButtonElement;
const btnDevice = document.getElementById("btnDevice") as HTMLButtonElement;
const btnCreateSendTransport = document.getElementById(
  "btnCreateSendTransport",
) as HTMLButtonElement;
const btnConnectSendTransport = document.getElementById(
  "btnConnectSendTransport",
) as HTMLButtonElement;
const btnCreateRecvTransport = document.getElementById(
  "btnRecvSendTransport",
) as HTMLButtonElement;
const btnConnectRecvTransport = document.getElementById(
  "btnConnectRecvTransport",
) as HTMLButtonElement;

let params: any = {
  encodings: [
    {
      rid: "r0",
      maxBitrate: 100000,
      scalabilityMode: "S1T3",
    },
    {
      rid: "r1",
      maxBitrate: 300000,
      scalabilityMode: "S1T3",
    },
    {
      rid: "r2",
      maxBitrate: 900000,
      scalabilityMode: "S1T3",
    },
  ],
  codecOptions: {
    videoGoogleStartBitrate: 1000,
  },
};

/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer
 **/

function streamSuccess(stream: MediaStream) {
  localVideo.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  params = { track, ...params };
}

async function createDevice() {
  try {
    device = new Device();

    await device.load({
      routerRtpCapabilities: rtpCapabilities,
    });

    console.log("RTP Capabilities", device.rtpCapabilities);
  } catch (e) {
    if (e instanceof Error) {
      if (e.name === "UnsupportedError") {
        console.warn("Browser not supported");
      }
    } else {
      console.warn("Unknown error caught:", e);
    }
  }
}

async function getLocalStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { min: 640, max: 1920 },
        height: { min: 400, max: 1080 },
      },
    });
    streamSuccess(stream);
  } catch (error) {
    console.log(error);
  }
}

function getRtpCapabilities() {
  socket.emit("getRtpCapabilities", (data: any) => {
    console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`);
    rtpCapabilities = data.rtpCapabilities;
  });
}

async function createSendTransport() {
  socket.emit("createWebRtcTransport", { sender: true }, ({ params }: any) => {
    if (params.error) {
      console.log(params.error);
      return;
    }

    console.log(params);
    producerTransport = device.createSendTransport(params);
    producerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          socket.emit("transport-connect", {
            dtlsParameters,
          });

          callback();
        } catch (error: any) {
          errback(error);
        }
      },
    );

    producerTransport.on("produce", (parameters, callback, errback) => {
      console.log(parameters);

      try {
        socket.emit(
          "transport-produce",
          {
            kind: parameters.kind,
            rtpParameters: parameters.rtpParameters,
            appData: parameters.appData,
          },
          ({ id }: any) => {
            callback({ id });
          },
        );
      } catch (error: any) {
        errback(error);
      }
    });
  });
}

async function connectSendTransport() {
  producer = await producerTransport.produce(params);

  producer.on("trackended", () => {
    console.log("track ended");
  });

  producer.on("transportclose", () => {
    console.log("transport ended");
  });
}

async function createRecvTransport() {
  console.log("maa ki chut");
  socket.emit("createWebRtcTransport", { sender: false }, ({ params }: any) => {
    if (params.error) {
      console.log(params.error);
      return;
    }

    console.log(params);

    // creates a new WebRTC Transport to receive media
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-createRecvTransport
    consumerTransport = device.createRecvTransport(params);

    // https://mediasoup.org/documentation/v3/communication-between-client-and-server/#producing-media
    consumerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          socket.emit("transport-recv-connect", {
            dtlsParameters,
          });

          callback();
        } catch (error: any) {
          errback(error);
        }
      },
    );
  });
}

async function connectRecvTransport() {
  socket.emit(
    "consume",
    {
      rtpCapabilities: device.rtpCapabilities,
    },
    async ({ params }: any) => {
      if (params.error) {
        console.log("Cannot Consume");
        return;
      }

      console.log(params);
      consumer = await consumerTransport.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      });

      const { track } = consumer;

      remoteVideo.srcObject = new MediaStream([track]);

      socket.emit("consumer-resume");
    },
  );
}

btnLocalVideo.addEventListener("click", getLocalStream);
btnRtpCapabilities.addEventListener("click", getRtpCapabilities);
btnDevice.addEventListener("click", createDevice);
btnCreateSendTransport.addEventListener("click", createSendTransport);
btnConnectSendTransport.addEventListener("mousedown", connectSendTransport);
btnCreateRecvTransport.addEventListener("click", createRecvTransport);
btnConnectRecvTransport.addEventListener("click", connectRecvTransport);
