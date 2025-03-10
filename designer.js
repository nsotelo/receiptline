/*
Copyright 2019 Open Foodservice System Consortium

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// QR Code is a registered trademark of DENSO WAVE INCORPORATED.

const http = require('http');
const path = require('path');
const fs = require('fs');
const net = require('net');
const receiptline = require('receiptline');
const servers = require('./servers.json');
let convert;
try {
    ({ convert } = require('convert-svg-to-png'));
}
catch (e) {
    // nothing to do
}

// Serial-LAN Converter
if ('serial' in servers) {
    const serialport = require('serialport');
    const serial = net.createServer(conn => {
        const port = new serialport(servers.serial.device, { autoOpen: false });
        port.on('error', err => {
            console.log(err);
            conn.destroy();
        });
        port.on('open', () => {
            conn.pipe(port).pipe(conn);
            conn.on('end', () => port.unpipe(conn));
            conn.on('close', had_error => port.drain(err => port.close()));
        });
        port.open();
    });
    serial.maxConnections = 1;
    serial.listen(servers.serial.port, () => {
        console.log(`Serial-LAN converter running at ${servers.serial.host}:${servers.serial.port}`);
    });
}

// Virtual Printer
if ('print' in servers) {
    const printer = net.createServer(conn => {
        conn.on('data', data => {
            console.log('Virtual printer received:');
            const hex = (data.toString('hex').replace(/../g, ' $&').replace(/.{24}/g, '$& ') + ' '.repeat(49)).match(/.{50}/g);
            const bin = (data.toString('binary').replace(/[^ -~]/g, '.') + ' '.repeat(15)).match(/.{16}/g);
            bin.forEach((b, i) => console.log(`${('0'.repeat(7) + (i << 4).toString(16)).slice(-8)} ${hex[i]} ${b}`));
            conn.write('\x00');
        });
    });
    printer.listen(servers.print.port, () => {
        console.log(`Virtual printer running at ${servers.print.host}:${servers.print.port}`);
    });
}

// ReceiptLine Server
if ('http' in servers) {
    const server = http.createServer((req, res) => {
        let pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
        switch (req.method) {
            case 'GET':
                if (pathname === '/') {
                    pathname = '/index.html';
                }
                fs.readFile(servers.http.root + pathname, (err, data) => {
                    if (err) {
                        res.writeHead(404);
                        res.end();
                    }
                    else {
                        res.writeHead(200, {'Content-Type': servers.http.mime[path.extname(pathname)] || servers.http.mime['.txt']});
                        res.end(data);
                    }
                });
                break;
            case 'POST':
                fs.readFile('./printers.json', 'utf8', (err, data) => {
                    if (err) {
                        res.writeHead(500);
                        res.end();
                    }
                    else {
                        let printers = {};
                        try {
                            printers = JSON.parse(data);
                        }
                        catch (e) {
                            // nothing to do
                        }
                        const pid = pathname.slice(1);
                        if (pid in printers) {
                            let text = '';
                            req.on('data', chunk => text += chunk);
                            req.on('end', () => {
                                const printer = printers[pid];
                                const host = printer.host || '127.0.0.1';
                                const port = printer.port || 19100;
                                const sock = net.connect(port, host);
                                let drain = false;
                                sock.on('connect', () => {
                                    if (printer.asImage && convert !== undefined) {
                                        const display = Object.assign({}, printer, { 'command': 'svg' });
                                        const svg = receiptline.transform(text, display);
                                        convert(svg).then(png => {
                                            const image = `|{i:${png.toString('base64')}}`;
                                            drain = sock.write(receiptline.transform(image, printer), 'binary');
                                        });
                                    }
                                    else {
                                        const command = receiptline.transform(text, printer);
                                        drain = sock.write(command, /^<svg/.test(command) ? 'utf8' : 'binary');
                                    }
                                });
                                sock.on('data', data => {
                                    if (drain) {
                                        sock.end();
                                        res.writeHead(200, {'Content-Type': 'text/plain'});
                                        res.end('success');
                                        drain = false;
                                    }
                                });
                                sock.on('drain', () => {
                                    drain = true;
                                });
                                sock.on('timeout', () => {
                                    sock.end();
                                    res.writeHead(200, {'Content-Type': 'text/plain'});
                                    res.end('failure');
                                });
                                sock.on('error', () => {
                                    res.writeHead(200, {'Content-Type': 'text/plain'});
                                    res.end('failure');
                                });
                                sock.setTimeout(servers.http.timeout);
                            });
                        }
                        else {
                            res.writeHead(404);
                            res.end();
                        }
                    }
                });
                break;
            default:
                res.end();
                break;
        }
    });
    server.listen(servers.http.port, servers.http.host, () => {
        console.log(`Server running at http://${servers.http.host}:${servers.http.port}/`);
    });
}
