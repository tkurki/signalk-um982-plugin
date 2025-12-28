
import { PathValue, Plugin, PluginConstructor, Position, ServerAPI } from '@signalk/server-api';
import { NtripConfig, NtripOptions, NtripOptionsSchema, startRTCM } from './ntrip';

export type Configuration = {
  serialDevice: string;
} & Omit<NtripOptions, 'xyz'> & Position


const pluginFactory: PluginConstructor = function (app: ServerAPI): Plugin {
  const selfContext = 'vessels.' + app.selfId;

  const knownNmeaConnections: any[] = []
  const knownSerialPorts: string[] = []
  let rtcmReceived: number | undefined = undefined


  const updatePluginStatus = () => {
    let status = rtcmReceived ? `RTCM data received ${new Date(rtcmReceived).toLocaleTimeString()}` : 'No RTCM data received yet'
    let errorStatus = false
    if (knownNmeaConnections.length === 0) {
      errorStatus = true
      status = 'No NMEA0183 data connections'
    }
    if (knownSerialPorts.length === 0) {
      errorStatus = true
      status += 'No serial ports detected'
    }
    if (errorStatus) {
      app.setPluginError(status);
    } else {
      app.setPluginError('');
      app.setPluginStatus(status);
    }
  }

  let serialWrite = (x: any) => undefined
  app.onPropertyValues('serialport', (values) => {
    console.log('Serial ports:', values);
    values.filter(v => v).forEach(({ value }) => {
      if (!knownSerialPorts.includes(value.id)) {
        knownSerialPorts.push(value.id);
      }
      serialWrite = (data: any) => (app as any).emit(value.eventNames.toStdout, data);
    })
  })

  let onStop = [] as (() => void)[];

  let currentSerialConnection: string | undefined = undefined

  return {
    id: 'tkurki-um982',
    name: 'Unicore UM982 GNSS Receiver',
    description: 'Signal K plugin for Unicore UM982 GNSS receiver',
    registerWithRouter: (router: any) => {
      router.post('/send/:sentence/:interval?', (req: any, res: any) => {
        const rawSentence = req.params.sentence;
        const rawInterval = req.params.interval;

        if (typeof rawSentence !== 'string') {
          res.status(400).json({ error: 'sentence parameter missing' });
          return;
        }

        const sentence = decodeURIComponent(rawSentence);
        const hasInterval = rawInterval !== undefined && rawInterval !== null && rawInterval !== '';

        if (!hasInterval) {
          serialWrite(sentence);
          res.status(200).json({ status: 'queued', sentence, interval: null });
          return;
        }

        const intervalValue = Number.parseFloat(rawInterval);

        if (!Number.isFinite(intervalValue) || intervalValue <= 0) {
          res.status(400).json({ error: 'interval parameter must be a positive number' });
          return;
        }

        const intervalString = Number.isInteger(intervalValue)
          ? intervalValue.toString()
          : intervalValue.toString();

        serialWrite(`${sentence} ${intervalString}`);

        res.status(200).json({ status: 'queued', sentence, interval: intervalValue });
      });
    },
    schema: () => {
      const serialConnectionEnum = [...knownSerialPorts];
      const result = {
        properties: {
          serialconnection: {
            type: "string",
            title: "Serial Connection",
            description: serialConnectionEnum.length === 0 ? 'You need to connect a serial port for a UM982 device first' : 'Select the serial connection for the UM982 device',
            enum: serialConnectionEnum,
            default: undefined as string | undefined
          },
          ntripEnabled: {
            type: "boolean",
            title: "NTRIP Enabled",
            default: true
          },
          ...NtripOptionsSchema.properties,
        },
        required: ["serialconnection"]
      };

      //add current value to enum if not present
      if (currentSerialConnection && !serialConnectionEnum.includes(currentSerialConnection)) {
        serialConnectionEnum.unshift(currentSerialConnection);
      }
      if (serialConnectionEnum.length > 0) {
        result.properties.serialconnection.default = serialConnectionEnum[0];
      }

      return result
    },
    start: (config_: NtripConfig & { serialconnection: string, ntripEnabled: boolean }) => {
      if (!validateConfiguration(config_)) {
        app.setPluginError('Invalid configuration');
        return;
      }
      currentSerialConnection = config_.serialconnection;
      app.setPluginError('');
      app.setPluginStatus('Starting');
      setTimeout(() => {
        serialWrite('MODE ROVER UAV')
        serialWrite('MODE')
        serialWrite('GPGSVH 1')
        serialWrite('BESTSATA 1')
        serialWrite('GPHPR 1')
        // serialWrite('CONFIG HEADING LENGTH 138 10')
        serialWrite('CONFIG')

        let closeRTCM: (() => void) | undefined = undefined;

        if (config_.ntripEnabled) {
          closeRTCM = startRTCM({
            options: config_,
            onData: (data: Buffer) => {
              serialWrite(data)
              rtcmReceived = Date.now()
            },
            onError: (e) => {
              console.error('RTCM Error', e)
            },
            onClose: () => {
              updatePluginStatus
            },
            onStationData: (delta: any) => app.handleMessage('N/A', delta)
          })
        }

        const updatePluginStatusTimer = setInterval(() => {
          updatePluginStatus()
        }, 1000)
        onStop.push(() => {
          clearInterval(updatePluginStatusTimer);
          if (closeRTCM) {
            closeRTCM();
          }
        });

      }, 1000);
      updatePluginStatus();
      app.onPropertyValues('pipedprovider', (values) => {
        values.filter(v => v).forEach(({ value }) => {
          console.log(value)
          if (value.type === 'Multiplexed') {
            if (knownNmeaConnections.indexOf(value.id) === -1) {
              knownNmeaConnections.push(value.id);
              (app as any).on(value.eventNames.received, (data: any) => {
                parseMultiplexedNmea(data.toString(), (delta: any) => app.handleMessage('N/A', delta));
              })
            }
          } else if (value.type === 'NMEA0183') {
            if (knownNmeaConnections.indexOf(value.id) === -1) {
              knownNmeaConnections.push(value.id);
              (app as any).on(value.eventNames.received, (data: any) => {
                parseNmeaSentence(data.toString(), (delta: any) => app.handleMessage('N/A', delta));
              })
            }
          }
        })
        updatePluginStatus();
      })

    },
    stop: () => {
      onStop.forEach(f => f());
      onStop = []
    }
  };
};

const parseMultiplexedNmea = (multiplexedLine: string, handleMessage: any) => {
  const [timestamp, discriminator, ...nmeaSentenceData] = multiplexedLine.split(';');
  const sentence = nmeaSentenceData.join(';').trim();
  parseNmeaSentence(sentence, handleMessage);
}

const parseNmeaSentence = (compleSentence: string, handleMessage: any) => {
  const parts = compleSentence.split(',')
  let parser = (_s: string[], sentence: string) => [] as PathValue[];
  switch (parts[0]) {
    case '#UNIHEADINGA':
      parser = uniheadingAParser
      break
    case '#MODE':
      parser = modeParser
      break
    case '#BESTSATA':
      parser = bestSatParser
      break
    case '$GNHPR':
      parser = hprParser
      break
    case '$CONFIG':
      parser = configParser
      break
    default:
      return;
  }
  // NOTE changed UNIHEADINGA parser to use 2nd param
  const values = parser(parts, compleSentence.split('*')[0]);
  if (values.length) {    
    // console.log(sentence)
    // console.log(values)   
    handleMessage({
      updates: [{
        values
      }]
    });
  }
}
/*
MODE ROVER

> GNRMC 1
$command,GNRMC 1,response: OK*1A

// configuration of UM-982:
// unlog: stop all logging on current port
// gphpr com1 1: Heading Pitch Roll on com1 every second
// config: show configuration
// saveconfig
// uniloglist
// freset: factory reset
// gpgga com1 1
// mode heading2 lowdynamic



*/

const configMap: { [key: string]: string } = {}
const configParser = (parts: string[]) => {
  configMap[parts[1]] = parts[2].slice(0, -4).split(' ').slice(2).join(' ');
  return [{
    path: 'sensors.rtk.um982',
    value: configMap
  }] as PathValue[];
}

const modeParser = (parts: string[]) => [{
  path: 'navigation.gnss.9820.mode',
  value: parts.slice(1).join(',')
} as PathValue];

const hprParser = (parts: string[]) => {
  return [{
    path: 'navigation.headingTrue',
    value: (parseFloat(parts[2]) + 90) * Math.PI / 180
  }
  ] as PathValue[]
}

// Decode BESTSATA signal mask field
const decodeBestSatMask = (maskHex: string, gnssSystem: string) => {
  const mask = parseInt(maskHex, 16);
  const signals: string[] = [];

  // Signal bit definitions vary by GNSS system
  switch (gnssSystem) {
    case 'GPS':
      if (mask & 0x01) signals.push('L1CA');
      if (mask & 0x02) signals.push('L1P');
      if (mask & 0x04) signals.push('L1M');
      if (mask & 0x08) signals.push('L2P');
      if (mask & 0x10) signals.push('L2M');
      if (mask & 0x20) signals.push('L5I');
      if (mask & 0x40) signals.push('L5Q');
      if (mask & 0x80) signals.push('L1C');
      break;

    case 'GLONASS':
      if (mask & 0x01) signals.push('L1CA');
      if (mask & 0x02) signals.push('L1P');
      if (mask & 0x04) signals.push('L2CA');
      if (mask & 0x08) signals.push('L2P');
      if (mask & 0x10) signals.push('L3I');
      if (mask & 0x20) signals.push('L3Q');
      break;

    case 'GALILEO':
      if (mask & 0x01) signals.push('E1B');
      if (mask & 0x02) signals.push('E1C');
      if (mask & 0x04) signals.push('E5aI');
      if (mask & 0x08) signals.push('E5aQ');
      if (mask & 0x10) signals.push('E5bI');
      if (mask & 0x20) signals.push('E5bQ');
      if (mask & 0x40) signals.push('E6B');
      if (mask & 0x80) signals.push('E6C');
      break;

    case 'BEIDOU':
      if (mask & 0x01) signals.push('B1I');
      if (mask & 0x02) signals.push('B1Q');
      if (mask & 0x04) signals.push('B2I');
      if (mask & 0x08) signals.push('B2Q');
      if (mask & 0x10) signals.push('B3I');
      if (mask & 0x20) signals.push('B3Q');
      break;

    case 'QZSS':
      if (mask & 0x01) signals.push('L1CA');
      if (mask & 0x02) signals.push('L1C');
      if (mask & 0x04) signals.push('L2C');
      if (mask & 0x08) signals.push('L5I');
      if (mask & 0x10) signals.push('L5Q');
      break;

    default:
      // For unknown systems, just return the hex value
      signals.push(`0x${maskHex}`);
  }

  return signals;
};

const bestSatParser = (parts: string[], sentence: string) => {
  // BESTSATA message format:
  // #BESTSATA,90,GPS,FINE,2389,362704000,0,0,18,24;18,GPS,1,GOOD,00000017,GPS,2,GOOD,00000011...
  // After preamble (first 10 parts including the semicolon split), entries have 4 fields:
  // satellite ID, GNSS system, status (ignored), signal mask

  if (parts.length < 10) {
    return [];
  }
  const [preamble, data] = sentence.split(';');

  const satellites: { gnss: string, id: string, mask: string, signals: string[] }[] = [];

  const satelliteData = data.split(',');
  for (let i = 0; i < Number(satelliteData[0]); i++) {
    const gnssSystem = satelliteData[i * 4 + 1];
    const satId = satelliteData[i * 4 + 2];
    const maskHex = satelliteData[i * 4 + 4];
    const signals = decodeBestSatMask(maskHex, gnssSystem);

    satellites.push({
      gnss: gnssSystem,
      id: satId,
      mask: maskHex,
      signals: signals
    });
  }

  return [{
    path: 'navigation.gnss.satellitesUsed',
    value: {
      satellites: satellites
    }
  } as PathValue];
};

const CONVERTERS = {
  UNIHEADINGA: [
    { index: 0, path: 'sensors.rtk.solutionStatus', convert: (v: string) => v },
    { index: 1, path: 'sensors.rtk.positionType', convert: (v: string) => v },
    { index: 2, path: 'sensors.rtk.baselineLength', convert: (v: string) => parseFloat(v) },
    {
      index: 3, path: 'navigation.headingTrue', convert: (v: string) => {
        if (v === '0.0000') return null;
        return ((parseFloat(v) + 90) % 360) * Math.PI / 180
      }
    },
    // { index: 3, path: 'navigation.headingTruedeg', convert: (v: string) => parseFloat(v) + 90 },
    { index: 4, path: 'navigation.attitude.pitch', convert: (v: string) => parseFloat(v) * Math.PI / 180 },
    { index: 6, path: 'navigation.positionHdop', convert: (v: string) => parseFloat(v) },
    { index: 7, path: 'navigation.positionVdop', convert: (v: string) => parseFloat(v) },
    { index: 9, path: 'navigation.satellites.inView', convert: (v: string) => parseInt(v, 10) },
    { index: 10, path: 'navigation.satellites.used', convert: (v: string) => parseInt(v, 10) },
    { index: 11, path: 'navigation.satellites.GPS', convert: (v: string) => parseInt(v, 10) },
    { index: 12, path: 'navigation.satellites.GLONASS', convert: (v: string) => parseInt(v, 10) },
    { index: 13, path: 'navigation.satellites.GALILEO', convert: (v: string) => parseInt(v, 10) },
    { index: 15, path: 'navigation.position.age', convert: (v: string) => parseFloat(v) },
    { index: 16, path: 'navigation.position.dgpsAge', convert: (v: string) => parseFloat(v) }
  ]
}
const POSITION_TYPE_INDEX = CONVERTERS.UNIHEADINGA.findIndex(c => c.path === 'sensors.rtk.positionType');
const HEADING_TRUE_INDEX = CONVERTERS.UNIHEADINGA.findIndex(c => c.path === 'navigation.headingTrue');

// modified UNIHEADINGA parser to extract entire message header
// (i.e. everything up to first semicolon)
// which lets field indexes match UM982 documentation
const uniheadingAParser = (parts: string[], sentence: string) => {
  console.log('UNIHEADINGA received:', sentence);

  // Split by semicolon first to separate header from data
  const [headerSection, dataSection] = sentence.split(';');

  if (!dataSection) {
    console.log('No data section found after semicolon');
    return [];
  }

  // Parse data section by commas (remove checksum if present)
  const dataFields = dataSection.split('*')[0].split(',');

  console.log('UNIHEADINGA data fields:', dataFields);

  const parsed = CONVERTERS.UNIHEADINGA.map(c => ({
    path: c.path,
    value: c.convert(dataFields[c.index])
  } as PathValue))

  console.log('UNIHEADINGA parsed values:', parsed);

  if (parsed[POSITION_TYPE_INDEX].value === 'NONE') {
    console.log('Position type is NONE, setting heading to null');
    parsed[HEADING_TRUE_INDEX].value = null;
  }

  return parsed;
}


//OBSVM


const sample = [
  '93', //0
  'GPS', //1
  'FINE', //2
  '2385', //3
  '326592000', //4
  '0', //5
  '0', //6
  '18', //7
  '10;SOL_COMPUTED', //8
  'NARROW_FLOAT', //9
  '5.4970', //10. Baseline length
  '219.2125', //11 Heading deg
  '24.6176', //12 pitch
  '0.0000', //13
  '15.8976', //14
  '34.8232', //15
  '"999"', //16
  '21', //17
  '9', //18
  '9', //19
  '5', //20
  '3', //21
  '00', //22
  '3', // 23
  '13' //24
]

function validateConfiguration(obj: any): obj is Configuration {
  console.log(obj)
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  // Only validate NTRIP configuration if NTRIP is enabled
  if (obj.ntripEnabled === true) {
    // Check required string properties for NTRIP
    if (
      typeof obj.host !== 'string' ||
      typeof obj.mountpoint !== 'string' ||
      typeof obj.username !== 'string' ||
      typeof obj.password !== 'string') {
      return false;
    }

    // Check required number properties for NTRIP
    if (typeof obj.port !== 'number' ||
      typeof obj.interval !== 'number' ||
      typeof obj.latitude !== 'number' ||
      typeof obj.longitude !== 'number') {
      return false;
    }

    // Check that numbers are valid for NTRIP
    if (!Number.isFinite(obj.port) || obj.port <= 0 ||
      !Number.isFinite(obj.interval) || obj.interval <= 0 ||
      !Number.isFinite(obj.latitude) ||
      !Number.isFinite(obj.longitude)) {
      return false;
    }

    // Check latitude/longitude ranges for NTRIP
    if (obj.latitude < -90 || obj.latitude > 90 ||
      obj.longitude < -180 || obj.longitude > 180) {
      return false;
    }
  }

  // Always validate serial connection is provided
  if (typeof obj.serialconnection !== 'string' || obj.serialconnection.trim() === '') {
    return false;
  }

  return true;
}

export default pluginFactory;
