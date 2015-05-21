﻿import packet = require("./sftp-packet");
import misc = require("./sftp-misc");
import enums = require("./sftp-enums");
import api = require("./fs-api");
import plus = require("./fs-plus");
import channel = require("./channel");
import util = require("./util");

import IStats = api.IStats;
import IItem = api.IItem;
import IFilesystem = api.IFilesystem;
import FilesystemPlus = plus.FilesystemPlus;
import ISession = channel.ISession;
import ISessionHost = channel.ISessionHost;
import ILogWriter = util.ILogWriter;
import Channel = channel.Channel;
import SftpPacket = packet.SftpPacket;
import SftpPacketWriter = packet.SftpPacketWriter;
import SftpPacketReader = packet.SftpPacketReader;
import SftpPacketType = enums.SftpPacketType;
import SftpStatusCode = enums.SftpStatusCode;
import SftpFlags = misc.SftpFlags;
import SftpStatus = misc.SftpStatus;
import SftpAttributes = misc.SftpAttributes;
import SftpItem = misc.SftpItem;
import toLogWriter = util.toLogWriter;

interface SftpRequest {
    callback: Function;
    responseParser: (reply: SftpPacket, callback: Function) => void;
    info: SftpCommandInfo;
}

interface SftpResponse extends SftpPacketReader {
    info: SftpCommandInfo;
}

interface SftpCommandInfo extends Object {
    command: string;
    path?: string;
    handle?: any;
}

class SftpHandle {
    _handle: NodeBuffer;
    _this: SftpClientCore;

    constructor(handle: NodeBuffer, owner: SftpClientCore) {
        this._handle = handle;
        this._this = owner;
    }

    toString(): string {
        var value = "0x";
        for (var i = 0; i < this._handle.length; i++) {
            var b = this._handle[i];
            var c = b.toString(16);
            if (b < 16) value += "0";
            value += c;
        }
        return value;
    }
}

class SftpClientCore implements ISession, IFilesystem {

    private _host: ISessionHost
    private _id: number;
    private _requests: SftpRequest[];
    private _ready: boolean;

    private _maxReadBlockLength: number;
    private _maxWriteBlockLength: number;

    private getRequest(type: number): SftpPacketWriter {
        var request = new SftpPacketWriter(this._maxWriteBlockLength + 1024); //TODO: cache buffers

        request.type = type;
        request.id = this._id;

        if (type == SftpPacketType.INIT) {
            if (this._id != null)
                throw new Error("Already initialized");
            this._id = 1;
        } else {
            this._id = (this._id + 1) & 0xFFFFFFFF;
        }

        request.start();
        return request;
    }

    private writeStats(packet: SftpPacketWriter, attrs?: IStats): void {
        var pattrs = new SftpAttributes();
        pattrs.from(attrs);
        pattrs.write(packet);
    }

    constructor() {
        this._host = null;
        this._id = null;
        this._ready = false;
        this._requests = [];

        this._maxWriteBlockLength = 32 * 1024;
        this._maxReadBlockLength = 256 * 1024;
    }

    private execute(request: SftpPacketWriter, callback: Function, responseParser: (response: SftpResponse, callback: Function) => void, info: SftpCommandInfo): void {

        if (typeof callback !== 'function') {
            // use dummy callback to prevent having to check this later
            callback = function () { };
        }

        if (typeof this._requests[request.id] !== 'undefined')
            throw new Error("Duplicate request");

        var packet = request.finish();
        this._host.send(packet);

        this._requests[request.id] = { callback: callback, responseParser: responseParser, info: info };

    }

    _init(host: ISessionHost, callback: (err: Error) => any): void {
        this._host = host;

        var request = this.getRequest(SftpPacketType.INIT);

        request.writeInt32(3); // SFTPv3

        this.execute(request, callback,(response, cb) => {

            if (response.type != SftpPacketType.VERSION) {
                callback(new Error("Protocol violation"));
                return;
            }

            var version = response.readInt32();
            if (version != 3) {
                callback(new Error("Protocol violation"));
                return;
            }

            this._ready = true;
            callback(null);
        }, { command: "init" });
    }

    _process(packet: NodeBuffer): void {
        var response = <SftpResponse>new SftpPacketReader(packet);

        var request = this._requests[response.id];

        if (typeof request === 'undefined')
            throw new Error("Unknown response ID");

        delete this._requests[response.id];

        response.info = request.info;

        request.responseParser.call(this, response, request.callback);
    }

    _end(): void {
    }

    end(): void {
        this._host.close();
    }

    open(path: string, flags: string, attrs?: IStats, callback?: (err: Error, handle: any) => any): void {
        path = this.toPath(path, 'path');

        if (typeof attrs === 'function' && typeof callback === 'undefined') {
            callback = <any>attrs;
            attrs = null;
        }

        var request = this.getRequest(SftpPacketType.OPEN);

        request.writeString(path);
        request.writeInt32(SftpFlags.toNumber(flags));
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseHandle, { command: "open", path: path });
    }

    close(handle: any, callback?: (err: Error) => any): void {
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.CLOSE);

        request.writeData(h);

        this.execute(request, callback, this.parseStatus, { command: "close", handle: handle });
    }

    read(handle: any, buffer: NodeBuffer, offset: number, length: number, position: number, callback?: (err: Error, bytesRead: number, buffer: NodeBuffer) => any): void {
        var h = this.toHandle(handle);
        this.checkBuffer(buffer, offset, length);
        this.checkPosition(position);

        // make sure the length is within reasonable limits
        if (length > this._maxReadBlockLength)
            length = this._maxReadBlockLength;

        var request = this.getRequest(SftpPacketType.READ);
        
        request.writeData(h);
        request.writeInt64(position);
        request.writeInt32(length);

        this.execute(request, callback,(response, cb) => this.parseData(response, callback, h, buffer, offset, length, position), { command: "read", handle: handle });
    }

    write(handle: any, buffer: NodeBuffer, offset: number, length: number, position: number, callback?: (err: Error) => any): void {
        var h = this.toHandle(handle);
        this.checkBuffer(buffer, offset, length);
        this.checkPosition(position);

        if (length > this._maxWriteBlockLength)
            throw new Error("Length exceeds maximum allowed data block length");

        var request = this.getRequest(SftpPacketType.WRITE);
        
        request.writeData(h);
        request.writeInt64(position);
        request.writeData(buffer, offset, offset + length);

        this.execute(request, callback, this.parseStatus, { command: "write", handle: handle });
    }

    lstat(path: string, callback?: (err: Error, attrs: IStats) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacketType.LSTAT, [path], callback, this.parseAttribs, { command: "lstat", path: path });
    }

    fstat(handle: any, callback?: (err: Error, attrs: IStats) => any): void {
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.FSTAT);

        request.writeData(h);

        this.execute(request, callback, this.parseAttribs, { command: "fstat", handle: handle });
    }

    setstat(path: string, attrs: IStats, callback?: (err: Error) => any): void {
        path = this.toPath(path, 'path');

        var request = this.getRequest(SftpPacketType.SETSTAT);

        request.writeString(path);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus, { command: "setstat", path: path });
    }

    fsetstat(handle: any, attrs: IStats, callback?: (err: Error) => any): void {
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.FSETSTAT);

        request.writeData(h);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus, { command: "fsetstat", handle: handle });
    }

    opendir(path: string, callback?: (err: Error, handle: any) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacketType.OPENDIR, [path], callback, this.parseHandle, { command: "opendir", path: path });
    }

    readdir(handle: any, callback?: (err: Error, items: IItem[]|boolean) => any): void {
        var h = this.toHandle(handle);

        var request = this.getRequest(SftpPacketType.READDIR);

        request.writeData(h);

        this.execute(request, callback, this.parseItems, { command: "readdir", handle: handle });
    }

    unlink(path: string, callback?: (err: Error) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacketType.REMOVE, [path], callback, this.parseStatus, { command: "unline", path: path });
    }

    mkdir(path: string, attrs?: IStats, callback?: (err: Error) => any): void {
        path = this.toPath(path, 'path');
        if (typeof attrs === 'function' && typeof callback === 'undefined') {
            callback = <any>attrs;
            attrs = null;
        }

        var request = this.getRequest(SftpPacketType.MKDIR);

        request.writeString(path);
        this.writeStats(request, attrs);

        this.execute(request, callback, this.parseStatus, { command: "mkdir", path: path });
    }

    rmdir(path: string, callback?: (err: Error) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacketType.RMDIR, [path], callback, this.parseStatus, { command: "rmdir", path: path });
    }

    realpath(path: string, callback?: (err: Error, resolvedPath: string) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacketType.REALPATH, [path], callback, this.parsePath, { command: "realpath", path: path });
    }

    stat(path: string, callback?: (err: Error, attrs: IStats) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacketType.STAT, [path], callback, this.parseAttribs, { command: "stat", path: path });
    }

    rename(oldPath: string, newPath: string, callback?: (err: Error) => any): void {
        oldPath = this.toPath(oldPath, 'oldPath');
        newPath = this.toPath(newPath, 'newPath');

        this.command(SftpPacketType.RENAME, [oldPath, newPath], callback, this.parseStatus, { command: "rename", oldPath: oldPath, newPath: newPath });
    }

    readlink(path: string, callback?: (err: Error, linkString: string) => any): void {
        path = this.toPath(path, 'path');

        this.command(SftpPacketType.READLINK, [path], callback, this.parsePath, { command: "readlink", path: path });
    }

    symlink(targetPath: string, linkPath: string, callback?: (err: Error) => any): void {
        targetPath = this.toPath(targetPath, 'targetPath');
        linkPath = this.toPath(linkPath, 'linkPath');

        this.command(SftpPacketType.SYMLINK, [targetPath, linkPath], callback, this.parseStatus, { command: "symlink", targetPath: targetPath, linkPath: linkPath });
    }

    private toHandle(handle: { _handle: NodeBuffer; _this: SftpClientCore }): NodeBuffer {
        if (!handle) {
            throw new Error("Missing handle");
        } else if (typeof handle === 'object') {
            if (SftpPacket.isBuffer(handle._handle) && handle._this == this)
                return handle._handle;
        }

        throw new Error("Invalid handle");
    }

    private toPath(path: string, name: string): string {
        if (typeof path !== 'string') {
            if (path == null || typeof path === 'undefined')
                throw new Error("Missing " + name);

            if (typeof path === 'function')
                throw new Error("Invalid " + name);

            path = <string>new String(path);
        }

        if (path.length == 0)
            throw new Error("Empty " + name);

        return path;
    }

    private checkBuffer(buffer: NodeBuffer, offset: number, length: number): void {
        if (!SftpPacket.isBuffer(buffer))
            throw new Error("Invalid buffer");

        if (typeof offset !== 'number' || offset < 0)
            throw new Error("Invalid offset");

        if (typeof length !== 'number' || length < 0)
            throw new Error("Invalid length");

        if ((offset + length) > buffer.length)
            throw new Error("Offset or length is out of bands");
    }

    private checkPosition(position: number): void {
        if (typeof position !== 'number' || position < 0 || position > 0x7FFFFFFFFFFFFFFF)
            throw new Error("Invalid position");
    }

    private command(command: number, args: string[], callback: Function, responseParser: (response: SftpResponse, callback: Function) => void, info: SftpCommandInfo): void {
        var request = this.getRequest(command);

        for (var i = 0; i < args.length; i++) {
            request.writeString(args[i]);
        }

        this.execute(request, callback, responseParser, info);
    }

    private readStatus(response: SftpResponse): Error {
        var nativeCode = response.readInt32();
        var message = response.readString();
        if (nativeCode == SftpStatusCode.OK)
            return null;

        var code;
        var errno;
        switch (nativeCode) {
            case SftpStatusCode.EOF:
                code = "EOF";
                errno = 1;
                break;
            case SftpStatusCode.PERMISSION_DENIED:
                code = "EACCES";
                errno = 3;
                break;
            case SftpStatusCode.NO_SUCH_FILE:
                code = "ENOENT";
                errno = 34;
                break;
            case SftpStatusCode.OP_UNSUPPORTED:
                code = "ENOSYS";
                errno = 35;
                break;
            case SftpStatusCode.FAILURE:
                code = "EFAILURE";
                errno = -2;
                break;
            default:
                code = "UNKNOWN";
                errno = -1;
                break;
        }

        var info = response.info;
        var command = info.command;
        var arg = info.path || info.handle;
        if (typeof arg === "string")
            arg = "'" + arg + "'";
        else if (arg)
            arg = new String(arg);
        else
            arg = "";

        var error = new Error(code + ", " + command + " " + arg);
        error['errno'] = errno;
        error['code'] = code;

        for (var name in info) {
            if (name == "command") continue;
            if (info.hasOwnProperty(name)) error[name] = info[name];
        }

        error['nativeCode'] = nativeCode;
        error['description'] = message;
        return error;
    }

    private checkResponse(response: SftpResponse, expectedType: number, callback: Function): boolean {
        if (response.type == SftpPacketType.STATUS) {
            var error = this.readStatus(response);
            if (error != null) {
                callback(error);
                return false;
            }
        }

        if (response.type != expectedType)
            throw new Error("Unexpected packet received");

        return true;
    }

    private parseStatus(response: SftpResponse, callback?: (err: Error) => any): void {
        if (!this.checkResponse(response, SftpPacketType.STATUS, callback))
            return;

        callback(null);
    }

    private parseAttribs(response: SftpResponse, callback?: (err: Error, attrs: IStats) => any): void {
        if (!this.checkResponse(response, SftpPacketType.ATTRS, callback))
            return;

        var attrs = new SftpAttributes(response);
        delete attrs.flags;

        callback(null, attrs);
    }

    private parseHandle(response: SftpResponse, callback?: (err: Error, handle: any) => any): void {
        if (!this.checkResponse(response, SftpPacketType.HANDLE, callback))
            return;

        var handle = response.readData(true);

        callback(null, new SftpHandle(handle, this));
    }

    private parsePath(response: SftpResponse, callback?: (err: Error, path?: string) => any): void {
        if (!this.checkResponse(response, SftpPacketType.NAME, callback))
            return;

        var count = response.readInt32();
        if (count != 1)
            throw new Error("Invalid response");

        var path = response.readString();

        callback(null, path);
    }

    private parseData(response: SftpResponse, callback: (err: Error, bytesRead: number, buffer: NodeBuffer) => any, h: NodeBuffer, buffer: NodeBuffer, offset: number, length: number, position: number): void {
        if (!this.checkResponse(response, SftpPacketType.DATA, callback))

        var data = response.readData(false);

        if (data.length > length)
            throw new Error("Received too much data");

        length = data.length;

        data.copy(buffer, offset, 0, length); //WEB: buffer.set(data, offset);

        callback(null, length, buffer);
    }

    private parseItems(response: SftpResponse, callback?: (err: Error, items: IItem[]|boolean) => any): void {

        if (response.type == SftpPacketType.STATUS) {
            var error = this.readStatus(response);
            if (error != null) {
                if (error['nativeCode'] == SftpStatusCode.EOF)
                    callback(null, false);
                else
                    callback(error, null);
                return;
            }
        }

        if (response.type != SftpPacketType.NAME)
            throw new Error("Unexpected packet received");

        var count = response.readInt32();

        var items: SftpItem[] = [];
        for (var i = 0; i < count; i++) {
            items[i] = new SftpItem(response);
        }

        callback(null, items);
    }
}

export class SftpClient extends FilesystemPlus {

    constructor(ws: any, local: IFilesystem, log?: ILogWriter) {

        log = toLogWriter(log);

        var sftp = new SftpClientCore();
        var channel = new Channel(sftp, ws, log);

        super(sftp, local);

        channel.once("open",() => {
            sftp._init(channel, err => {
                if (err != null) {
                    this.emit('error', err);
                    channel.close(3002);
                } else {
                    this.emit('ready');
                }
            });
        });

        channel.once("close",(err) => {
            this.emit('close', err);
        });
    }

    end(): void {
        (<SftpClientCore>this._fs).end();
    }
}
