import { Section } from "lcov-parse";
import {
    Disposable,
    FileSystemWatcher,
    OutputChannel,
    TextEditor,
    window,
    workspace,
    WorkspaceFolder
} from "vscode";

import { Config } from "../extension/config";
import { CoverageParser } from "../files/coverageparser";
import { FilesLoader } from "../files/filesloader";
import { Renderer } from "./renderer";
import { SectionFinder } from "./sectionfinder";

enum Status {
    ready = "READY",
    initializing = "INITIALIZING",
    loading = "LOADING",
    rendering = "RENDERING",
    error = "ERROR",
}

export class CoverageService {
    private configStore: Config;
    private outputChannel: OutputChannel;
    private filesLoader: FilesLoader;
    private renderer: Renderer;
    private coverageParser: CoverageParser;
    private coverageWatchers: FileSystemWatcher[];
    private editorWatcher: Disposable;
    private sectionFinder: SectionFinder;

    private cache: Map<string, Section>;

    constructor(
        configStore: Config,
        outputChannel: OutputChannel,
    ) {
        this.configStore = configStore;
        this.outputChannel = outputChannel;
        this.updateServiceState(Status.initializing);
        this.cache = new Map();
        this.filesLoader = new FilesLoader(configStore);
        this.sectionFinder = new SectionFinder(
            configStore,
            this.outputChannel,
        );
        this.renderer = new Renderer(
            configStore,
            this.sectionFinder,
        );
        this.coverageParser = new CoverageParser(this.outputChannel);
    }

    public dispose() {
        if (this.coverageWatchers) { this.coverageWatchers.map(cw => cw.dispose()) }
        if (this.editorWatcher) { this.editorWatcher.dispose(); }
        this.cache = new Map(); // reset cache to empty
        const visibleEditors = window.visibleTextEditors;
        this.renderer.renderCoverage(this.cache, visibleEditors);
    }

    public async displayForFile() {
        await this.loadCacheAndRender();
    }

    public async watchWorkspace() {
        await this.displayForFile();
        this.listenToFileSystem();
        this.listenToEditorEvents();
    }

    public async removeCoverageForCurrentEditor() {
        const visibleEditors = window.visibleTextEditors;
        await this.renderer.renderCoverage(new Map(), visibleEditors);
    }

    private async loadCache() {
        try {
            const printDataCoverage = (data: Map<string, Section>) => {
                this.outputChannel.appendLine(
                    `[${Date.now()}][printDataCoverage]: Coverage -> ${data.size}`,
                );
                /*
                data.forEach((section) => {
                    const coverage = JSON.stringify(section, null, 4);
                    this.outputChannel.appendLine(
                        `[${Date.now()}][printDataCoverage]: ${coverage}`,
                    );
                });
                */
            };

            this.updateServiceState(Status.loading);
            const files = await this.filesLoader.findCoverageFiles();
            this.outputChannel.appendLine(
                `[${Date.now()}][coverageservice]: Loading ${files.size} file(s)`,
            );
            const dataFiles = await this.filesLoader.loadDataFiles(files);
            this.outputChannel.appendLine(
                `[${Date.now()}][coverageservice]: Loaded ${dataFiles.size} data file(s)`,
            );
            const dataCoverage = await this.coverageParser.filesToSections(dataFiles);
            this.outputChannel.appendLine(
                `[${Date.now()}][coverageservice]: Caching ${dataCoverage.size} coverage(s)`,
            );
            this.cache = dataCoverage;
            printDataCoverage(this.cache);
            this.updateServiceState(Status.ready);
        } catch (error) {
            this.handleError(error);
        }
    }

    private updateServiceState(state: Status) {
        this.outputChannel.appendLine(
            `[${Date.now()}][coverageservice]: ${state}`);
    }

    private async loadCacheAndRender() {
        await this.loadCache();
        this.updateServiceState(Status.rendering);
        const visibleEditors = window.visibleTextEditors;
        await this.renderer.renderCoverage(this.cache, visibleEditors);
        this.updateServiceState(Status.ready);
    }

    private listenToFileSystem() {
        let blobPattern;
        if (this.configStore.manualCoverageFilePaths.length) {
            blobPattern = `${this.configStore.manualCoverageFilePaths}`
            const coverageWatcher = workspace.createFileSystemWatcher(blobPattern);
            coverageWatcher.onDidChange(this.loadCacheAndRender.bind(this));
            coverageWatcher.onDidCreate(this.loadCacheAndRender.bind(this));
            coverageWatcher.onDidDelete(this.loadCacheAndRender.bind(this));
            this.coverageWatchers = [coverageWatcher];
        } else {
            const fileNames = this.configStore.coverageFileNames.toString();
            // Creates a BlobPattern for all coverage files.
            // EX: `**/{cov.xml, lcov.info}`
            blobPattern = `{${fileNames}}`;
            if (workspace.workspaceFolders) {
                this.coverageWatchers = workspace.workspaceFolders.map((workspaceFolder) => {
                    const fullPattern = `${workspaceFolder.uri.fsPath}/${blobPattern}`
                    const coverageWatcher = workspace.createFileSystemWatcher(fullPattern);
                    coverageWatcher.onDidChange(this.loadCacheAndRender.bind(this));
                    coverageWatcher.onDidCreate(this.loadCacheAndRender.bind(this));
                    coverageWatcher.onDidDelete(this.loadCacheAndRender.bind(this));
                    return coverageWatcher;
                });
            }
        }
    }

    private async handleEditorEvents(textEditors: TextEditor[]) {
        this.updateServiceState(Status.rendering);
        await this.renderer.renderCoverage(
            this.cache,
            textEditors,
        );
        this.updateServiceState(Status.ready);
    }

    private listenToEditorEvents() {
        this.editorWatcher = window.onDidChangeVisibleTextEditors(
            this.handleEditorEvents.bind(this),
        );
    }

    private handleError(error: Error) {
        const message = error.message ? error.message : error;
        const stackTrace = error.stack;
        window.showWarningMessage(message.toString());
        this.outputChannel.appendLine(`[${Date.now()}][gutters]: Error ${message}`);
        this.outputChannel.appendLine(`[${Date.now()}][gutters]: Stacktrace ${stackTrace}`);
    }
}
