/*
 Copyright (c) 2019-2020 Xiamen Yaji Software Co., Ltd.

 https://www.cocos.com/

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated engine source code (the "Software"), a limited,
 worldwide, royalty-free, non-assignable, revocable and non-exclusive license
 to use Cocos Creator solely to develop games on your target platforms. You shall
 not use Cocos Creator software for developing other software or tools that's
 used for developing games. You are not granted to publish, distribute,
 sublicense, and/or sell copies of Cocos Creator.

 The software or tools in this License Agreement are licensed, not sold.
 Xiamen Yaji Software Co., Ltd. reserves all rights not expressly granted to you.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
*/
/**
 * @packageDocumentation
 * @hidden
*/
import { JSB } from 'internal:constants';
import { Camera, Model } from 'cocos/core/renderer/scene';
import { UIStaticBatch } from '../components/ui-static-batch';
import { Material } from '../../core/assets/material';
import { RenderRoot2D, Renderable2D, UIComponent } from '../framework';
import { Texture, Device, Attribute, Sampler, DescriptorSetInfo, Buffer, BufferInfo, BufferUsageBit, MemoryUsageBit, DescriptorSet } from '../../core/gfx';
import { Pool, RecyclePool } from '../../core/memop';
import { CachedArray } from '../../core/memop/cached-array';
import { RenderScene } from '../../core/renderer/scene/render-scene';
import { Root } from '../../core/root';
import { Node } from '../../core/scene-graph';
import { MeshBuffer } from './mesh-buffer';
import { Stage, StencilManager } from './stencil-manager';
import { DrawBatch2DGPU } from './draw-batch-gpu';
import * as VertexFormat from './vertex-format';
import { legacyCC } from '../../core/global-exports';
import { ModelLocalBindings, UBOLocal } from '../../core/pipeline/define';
import { SpriteFrame } from '../assets';
import { TextureBase } from '../../core/assets/texture-base';
import { Mat4 } from '../../core/math';
import { UILocalUBOManger } from './render-uniform-buffer';
import { CommonQuadIA } from './common-quad-ia';
import { sys } from '../../core/platform/sys';
import { IBatcher } from './i-batcher';
import { DrawBatch2D, DrawCall } from './draw-batch';

const _dsInfo = new DescriptorSetInfo(null!);
const m4_1 = new Mat4();

/**
 * @zh
 * UI 渲染流程
 */
export class Batcher2D implements IBatcher {
    get currBufferBatch () {
        if (this._currMeshBuffer) return this._currMeshBuffer;
        // create if not set
        this._currMeshBuffer = this.acquireBufferBatch();
        return this._currMeshBuffer;
    }

    set currBufferBatch (buffer: MeshBuffer | null) {
        if (buffer) {
            this._currMeshBuffer = buffer;
        }
    }

    get batches () {
        return this._batches;
    }

    /**
     * Acquire a new mesh buffer if the vertex layout differs from the current one.
     * @param attributes
     */
    public acquireBufferBatch (attributes: Attribute[] = VertexFormat.vfmtPosUvColor) {
        const strideBytes = attributes === VertexFormat.vfmtPosUvColor ? 36 /* 9x4 */ : VertexFormat.getAttributeStride(attributes);
        if (!this._currMeshBuffer || (this._currMeshBuffer.vertexFormatBytes) !== strideBytes) {
            this._requireBufferBatch(attributes);
            return this._currMeshBuffer;
        }
        return this._currMeshBuffer;
    }

    public registerCustomBuffer (attributes: MeshBuffer | Attribute[], callback: ((...args: number[]) => void) | null) {
        let batch: MeshBuffer;
        if (attributes instanceof MeshBuffer) {
            batch = attributes;
        } else {
            batch = this._bufferBatchPool.add();
            batch.initialize(attributes, callback || this._recreateMeshBuffer.bind(this, attributes));
        }
        const strideBytes = batch.vertexFormatBytes;
        let buffers = this._customMeshBuffers.get(strideBytes);
        if (!buffers) { buffers = []; this._customMeshBuffers.set(strideBytes, buffers); }
        buffers.push(batch);
        return batch;
    }

    public unRegisterCustomBuffer (buffer: MeshBuffer) {
        const buffers = this._customMeshBuffers.get(buffer.vertexFormatBytes);
        if (buffers) {
            for (let i = 0; i < buffers.length; i++) {
                if (buffers[i] === buffer) {
                    buffers.splice(i, 1);
                    break;
                }
            }
        }

        // release the buffer to recycle pool --
        const idx = this._bufferBatchPool.data.indexOf(buffer);
        if (idx !== -1) {
            buffer.reset();
            this._bufferBatchPool.removeAt(idx);
        }
        // ---
    }

    set currStaticRoot (value: UIStaticBatch | null) {
        this._currStaticRoot = value;
    }

    set currIsStatic (value: boolean) {
        this._currIsStatic = value;
    }

    public device: Device;
    private _screens: RenderRoot2D[] = [];
    private _drawBatchPool: Pool<DrawBatch2DGPU>;

    private _bufferBatchPool: RecyclePool<MeshBuffer> = new RecyclePool(() => new MeshBuffer(this), 128);
    private _meshBuffers: Map<number, MeshBuffer[]> = new Map();
    private _customMeshBuffers: Map<number, MeshBuffer[]> = new Map();
    private _meshBufferUseCount: Map<number, number> = new Map();

    private _batches: CachedArray<DrawBatch2DGPU | DrawBatch2D>;
    private _emptyMaterial = new Material();
    private _currScene: RenderScene | null = null;
    private _currMaterial: Material = this._emptyMaterial;
    private _currTexture: Texture | null = null;
    private _currSampler: Sampler | null = null;
    private _currMeshBuffer: MeshBuffer | null = null;
    private _currStaticRoot: UIStaticBatch | null = null;
    private _currComponent: Renderable2D | null = null;
    private _currTransform: Node | null = null;
    private _currTextureHash = 0;
    private _currSamplerHash = 0;
    private _currBlendTargetHash = 0;
    private _currLayer = 0;
    private _currDepthStencilStateStage: any | null = null;
    private _currIsStatic = false;
    private _currOpacity = 1;

    // macro.UI_GPU_DRIVEN
    private _currBatch!: DrawBatch2DGPU;

    // DescriptorSet Cache Map
    private _descriptorSetCache = new DescriptorSetCache();

    // macro.UI_GPU_DRIVEN
    private _dummyIA: CommonQuadIA;
    private _localUBOManager: UILocalUBOManger;

    private _currTypeIsGPU = false;

    // macro.UI_GPU_DRIVEN
    private _reloadBatchDirty: boolean;

    // -------------------------------------

    constructor (private _root: Root) {
        this.device = _root.device;
        this._batches = new CachedArray(64);
        this._drawBatchPool = new Pool(() => new DrawBatch2DGPU(), 128);
        // macro.UI_GPU_DRIVEN
        this._dummyIA = new CommonQuadIA(this.device);
        this._localUBOManager = new UILocalUBOManger(this.device);
        this._reloadBatchDirty = true;
        this._currBatch = this._drawBatchPool.alloc();
    }

    public initialize () {
        // macro.UI_GPU_DRIVEN
        legacyCC.director.on(legacyCC.Director.EVENT_AFTER_SCENE_LAUNCH, () => {
            this._reloadBatchDirty = true;
        });
        return true;
    }

    public destroy () {
        for (let i = 0; i < this._batches.length; i++) {
            if (this._batches.array[i]) {
                this._batches.array[i].destroy(this);
            }
        }
        this._batches.destroy();

        for (const size of this._meshBuffers.keys()) {
            const buffers = this._meshBuffers.get(size);
            if (buffers) {
                buffers.forEach((buffer) => buffer.destroy());
            }
        }

        if (this._drawBatchPool) {
            this._drawBatchPool.destroy((obj) => {
                obj.destroy(this);
            });
        }

        this._descriptorSetCache.destroy();

        this._meshBuffers.clear();

        StencilManager.sharedManager!.destroy();
    }

    /**
     * @en
     * Add the managed Canvas.
     *
     * @zh
     * 添加屏幕组件管理。
     *
     * @param comp - 屏幕组件。
     */
    public addScreen (comp: RenderRoot2D) {
        this._screens.push(comp);
        this._screens.sort(this._screenSort);
    }

    public getFirstRenderCamera (node: Node): Camera | null {
        if (node.scene && node.scene.renderScene) {
            const cameras = node.scene.renderScene.cameras;
            for (let i = 0; i < cameras.length; i++) {
                const camera = cameras[i];
                if (camera.visibility & node.layer) {
                    return camera;
                }
            }
        }
        return null;
    }

    /**
     * @zh
     * Removes the Canvas from the list.
     *
     * @param comp - 被移除的屏幕。
     */
    public removeScreen (comp: RenderRoot2D) {
        const idx = this._screens.indexOf(comp);
        if (idx === -1) {
            return;
        }

        this._screens.splice(idx, 1);
    }

    public sortScreens () {
        this._screens.sort(this._screenSort);
    }

    public update () {
        // macro.UI_GPU_DRIVEN
        this._localUBOManager.reset();
        if (this._reloadBatchDirty) {
            // release localDS
            this._descriptorSetCache.releaseAllByBuffer();
        }

        const screens = this._screens;
        for (let i = 0; i < screens.length; ++i) {
            const screen = screens[i];
            if (!screen.enabledInHierarchy) {
                continue;
            }
            this._currOpacity = 1;
            this._recursiveScreenNode(screen.node);
            // macro.UI_GPU_DRIVEN
            this._currTypeIsGPU = false;
        }

        let batchPriority = 0;
        if (this._batches.length) {
            for (let i = 0; i < this._batches.length; ++i) {
                const batch = this._batches.array[i];
                if (!batch.renderScene) continue;

                if (batch.model) {
                    const subModels = batch.model.subModels;
                    for (let j = 0; j < subModels.length; j++) {
                        subModels[j].priority = batchPriority++;
                    }
                } else {
                    // macro.UI_GPU_DRIVEN
                    for (let i = 0; i < batch.drawCalls.length; i++) {
                        batch.drawCalls[i].descriptorSet = this._descriptorSetCache.getDescriptorSet(batch, batch.drawCalls[i]);
                    }
                }
                batch.renderScene.addBatch(batch);
            }
        }
    }

    public uploadBuffers () {
        if (this._batches.length > 0) {
            const buffers = this._meshBuffers;
            buffers.forEach((value, key) => {
                value.forEach((bb) => {
                    bb.uploadBuffers();
                    bb.reset();
                });
            });

            const customs = this._customMeshBuffers;
            customs.forEach((value, key) => {
                value.forEach((bb) => {
                    bb.uploadBuffers();
                    bb.reset();
                });
            });

            this._descriptorSetCache.update();
            // macro.UI_GPU_DRIVEN
            this._localUBOManager.updateBuffer();
            this._reloadBatchDirty = false;
        }
    }

    public reset () {
        for (let i = 0; i < this._batches.length; ++i) {
            const batch = this._batches.array[i];
            if (batch.isStatic) {
                continue;
            }

            batch.clear();
            this._drawBatchPool.free(batch as DrawBatch2DGPU);
        }
        // macro.UI_GPU_DRIVEN
        DrawBatch2D.drawcallPool.reset();

        this._currLayer = 0;
        this._currMaterial = this._emptyMaterial;
        this._currTexture = null;
        this._currSampler = null;
        this._currComponent = null;
        this._currTransform = null;
        this._currScene = null;
        this._currMeshBuffer = null;
        this._currOpacity = 1;
        this._meshBufferUseCount.clear();
        // macro.UI_GPU_DRIVEN
        this._batches.clear();
        StencilManager.sharedManager!.reset();
        this._descriptorSetCache.reset();
    }

    // macro.UI_GPU_DRIVEN
    private _commitCompByGPU (comp: Renderable2D, frame: TextureBase | SpriteFrame | null, assembler: any, transform: Node | null) {
        const renderComp = comp;
        let texture;
        let samp;
        let textureHash = 0;
        let samplerHash = 0;
        if (frame) {
            texture = frame.getGFXTexture();
            samp = frame.getGFXSampler();
            textureHash = frame.getHash();
            samplerHash = samp.hash;
        } else {
            texture = null;
            samp = null;
        }

        const renderScene = renderComp._getRenderScene();
        const mat = renderComp.getRenderMaterial(0)!;
        renderComp.stencilStage = StencilManager.sharedManager!.stage;

        const blendTargetHash = renderComp.blendHash;
        const depthStencilStateStage = renderComp.stencilStage;

        if (this._currScene !== renderScene || this._currLayer !== comp.node.layer || this._currMaterial !== mat
            || this._currBlendTargetHash !== blendTargetHash || this._currDepthStencilStateStage !== depthStencilStateStage
            || this._currTextureHash !== textureHash || this._currSamplerHash !== samplerHash || this._currTransform !== transform || this._currTypeIsGPU !== true) {
            if (this._currTypeIsGPU) {
                // G -> G
                this.autoMergeBatchesByGPU(this._currComponent!);
                this._currBatch = this._drawBatchPool.alloc();
                this._currBatch.capacityDirty = true;
            } else {
                // A -> G
                this.autoMergeBatches(this._currComponent!);
                this._currBatch = this._drawBatchPool.alloc();
            }
            this._currScene = renderScene;
            this._currComponent = renderComp;
            this._currTransform = transform;
            this._currMaterial = mat;
            this._currTexture = texture;
            this._currSampler = samp;
            this._currTextureHash = textureHash;
            this._currSamplerHash = samplerHash;
            this._currBlendTargetHash = blendTargetHash;
            this._currDepthStencilStateStage = depthStencilStateStage;
            this._currLayer = comp.node.layer;
        }
        this._currTypeIsGPU = true;

        const uiPros = comp.node._uiProps;
        if (comp.node.hasChangedFlags) {
            uiPros.uiTransformComp!.setRectDirty(comp.node.hasChangedFlags);
        }
        const localBuffer = this._currBatch.fillBuffers(comp, this._localUBOManager, mat, this);
        this._resetRenderDirty(comp);
        this._currBatch.fillDrawCall(localBuffer);
    }

    private _commitComp (comp: Renderable2D, frame: TextureBase | SpriteFrame | null, assembler: any, transform: Node | null) {
        const renderComp = comp;
        let texture;
        let samp;
        let textureHash = 0;
        let samplerHash = 0;
        if (frame) {
            texture = frame.getGFXTexture();
            samp = frame.getGFXSampler();
            textureHash = frame.getHash();
            samplerHash = samp.hash;
        } else {
            texture = null;
            samp = null;
        }

        const renderScene = renderComp._getRenderScene();
        const mat = renderComp.getRenderMaterial(0)!;
        renderComp.stencilStage = StencilManager.sharedManager!.stage;

        const blendTargetHash = renderComp.blendHash;
        const depthStencilStateStage = renderComp.stencilStage;

        if (this._currScene !== renderScene || this._currLayer !== comp.node.layer || this._currMaterial !== mat
            || this._currBlendTargetHash !== blendTargetHash || this._currDepthStencilStateStage !== depthStencilStateStage
            || this._currTextureHash !== textureHash || this._currSamplerHash !== samplerHash || this._currTransform !== transform || this._currTypeIsGPU !== false) {
            // macro.UI_GPU_DRIVEN
            if (this._currTypeIsGPU) {
                // G -> A
                this.autoMergeBatchesByGPU(this._currComponent!);
                this._currBatch = this._drawBatchPool.alloc();
                this._currBatch.capacityDirty = true;
            } else {
                // A -> A
                this.autoMergeBatches(this._currComponent!);
                this._currBatch = this._drawBatchPool.alloc();
            }

            this._currScene = renderScene;
            this._currComponent = renderComp;
            this._currTransform = transform;
            this._currMaterial = mat;
            this._currTexture = texture;
            this._currSampler = samp;
            this._currTextureHash = textureHash;
            this._currSamplerHash = samplerHash;
            this._currBlendTargetHash = blendTargetHash;
            this._currDepthStencilStateStage = depthStencilStateStage;
            this._currLayer = comp.node.layer;
            this._currBatch.capacityDirty = true;
        }

        this._currTypeIsGPU = false;

        if (assembler) {
            assembler.fillBuffers(renderComp, this);
        }
    }

    /**
     * @en
     * Render component data submission process of UI.
     * The submitted vertex data is the UI for world coordinates.
     * For example: The UI components except Graphics and UIModel.
     *
     * @zh
     * UI 渲染组件数据提交流程（针对提交的顶点数据是世界坐标的提交流程，例如：除 Graphics 和 UIModel 的大部分 ui 组件）。
     * 此处的数据最终会生成需要提交渲染的 model 数据。
     *
     * @param comp - 当前执行组件。
     * @param frame - 当前执行组件贴图。
     * @param assembler - 当前组件渲染数据组装器。
     */
    public commitComp (comp: Renderable2D, frame: TextureBase | SpriteFrame | null, assembler: any, transform: Node | null) {
        // @ts-expect-error hack
        if (comp._canDrawByFourVertex) {
            this._commitCompByGPU(comp, frame, assembler, transform);
        } else {
            this._commitComp(comp, frame, assembler, transform);
        }
    }

    /**
     * @en
     * Render component data submission process of UI.
     * The submitted vertex data is the UI for local coordinates.
     * For example: The UI components of Graphics and UIModel.
     *
     * @zh
     * UI 渲染组件数据提交流程（针对例如： Graphics 和 UIModel 等数据量较为庞大的 ui 组件）。
     *
     * @param comp - 当前执行组件。
     * @param model - 提交渲染的 model 数据。
     * @param mat - 提交渲染的材质。
     */
    public commitModel (comp: UIComponent | Renderable2D, model: Model | null, mat: Material | null) {
        // if the last comp is spriteComp, previous comps should be batched.
        // macro.UI_GPU_DRIVEN
        if (this._currMaterial !== this._emptyMaterial) {
            if (this._currTypeIsGPU) {
                this.autoMergeBatchesByGPU(this._currComponent!);
            } else {
                this.autoMergeBatches(this._currComponent!);
            }
        }

        let depthStencil;
        let dssHash = 0;
        if (mat) {
            // Notice: A little hack, if not this two stage, not need update here, while control by stencilManger
            if (comp.stencilStage === Stage.ENABLED || comp.stencilStage === Stage.DISABLED) {
                comp.stencilStage = StencilManager.sharedManager!.stage;
            }
            depthStencil = StencilManager.sharedManager!.getStencilStage(comp.stencilStage, mat);
            dssHash = StencilManager.sharedManager!.getStencilHash(comp.stencilStage);
        }

        const stamp = legacyCC.director.getTotalFrames();
        if (model) {
            model.updateTransform(stamp);
            model.updateUBOs(stamp);
        }

        for (let i = 0; i < model!.subModels.length; i++) {
            const curDrawBatch = this._drawBatchPool.alloc();
            const subModel = model!.subModels[i];
            curDrawBatch.renderScene = comp._getRenderScene();
            curDrawBatch.visFlags = comp.node.layer;
            curDrawBatch.model = model;
            curDrawBatch.bufferBatch = null;
            curDrawBatch.texture = null;
            curDrawBatch.sampler = null;
            curDrawBatch.useLocalData = null;
            if (!depthStencil) { depthStencil = null; }
            curDrawBatch.fillPasses(mat, depthStencil, dssHash, null, 0, subModel.patches, this);
            curDrawBatch.inputAssembler = subModel.inputAssembler;
            curDrawBatch.model!.visFlags = curDrawBatch.visFlags;
            curDrawBatch.fillDrawCallAssembler();
            curDrawBatch.drawCalls[0].descriptorSet = subModel.descriptorSet;
            this._batches.push(curDrawBatch);
        }

        // reset current render state to null
        this._currMaterial = this._emptyMaterial;
        this._currScene = null;
        this._currComponent = null;
        this._currTransform = null;
        this._currTexture = null;
        this._currSampler = null;
        this._currTextureHash = 0;
        this._currSamplerHash = 0;
        this._currLayer = 0;
        // macro.UI_GPU_DRIVEN
        this._currTypeIsGPU = false;
    }

    /**
     * @en
     * Submit separate render data.
     * This data does not participate in the batch.
     *
     * @zh
     * 提交独立渲染数据.
     * @param comp 静态组件
     */
    public commitStaticBatch (comp: UIStaticBatch) {
        this._batches.concat(comp.drawBatchList);
        this.finishMergeBatches();
    }

    // macro.UI_GPU_DRIVEN
    private autoMergeBatchesByGPU (renderComp?: Renderable2D) {
        if (!this._currScene) return;

        let blendState;
        let depthStencil;
        let dssHash = 0;
        let bsHash = 0;
        if (renderComp) {
            blendState = renderComp.blendHash === -1 ? null : renderComp.getBlendState();
            bsHash = renderComp.blendHash;
            if (renderComp.customMaterial !== null) {
                depthStencil = StencilManager.sharedManager!.getStencilStage(renderComp.stencilStage, this._currMaterial);
            } else {
                depthStencil = StencilManager.sharedManager!.getStencilStage(renderComp.stencilStage);
            }
            dssHash = StencilManager.sharedManager!.getStencilHash(renderComp.stencilStage);
        }

        const curDrawBatch = this._currStaticRoot ? this._currStaticRoot._requireDrawBatch() : this._currBatch;
        curDrawBatch.renderScene = this._currScene;
        curDrawBatch.visFlags = this._currLayer;
        curDrawBatch.texture = this._currTexture!;
        curDrawBatch.sampler = this._currSampler;
        curDrawBatch.inputAssembler = this._dummyIA.ia;
        curDrawBatch.useLocalData = this._currTransform;
        curDrawBatch.textureHash = this._currTextureHash;
        curDrawBatch.samplerHash = this._currSamplerHash;
        curDrawBatch.fillPasses(this._currMaterial, depthStencil, dssHash, blendState, bsHash, null, this);

        this._batches.push(curDrawBatch);
    }

    /**
     * @en
     * End a section of render data and submit according to the batch condition.
     *
     * @zh
     * 根据合批条件，结束一段渲染数据并提交。
     */
    public autoMergeBatches (renderComp?: Renderable2D) {
        const buffer = this.currBufferBatch;
        const ia = buffer?.recordBatch();
        const mat = this._currMaterial;
        if (!ia || !mat || !buffer) {
            return;
        }
        let blendState;
        let depthStencil;
        let dssHash = 0;
        let bsHash = 0;
        if (renderComp) {
            blendState = renderComp.blendHash === -1 ? null : renderComp.getBlendState();
            bsHash = renderComp.blendHash;
            if (renderComp.customMaterial !== null) {
                depthStencil = StencilManager.sharedManager!.getStencilStage(renderComp.stencilStage, mat);
            } else {
                depthStencil = StencilManager.sharedManager!.getStencilStage(renderComp.stencilStage);
            }
            dssHash = StencilManager.sharedManager!.getStencilHash(renderComp.stencilStage);
        }

        const curDrawBatch = this._currStaticRoot ? this._currStaticRoot._requireDrawBatch() : this._currBatch;
        curDrawBatch.renderScene = this._currScene;
        curDrawBatch.visFlags = this._currLayer;
        curDrawBatch.bufferBatch = buffer;
        curDrawBatch.texture = this._currTexture!;
        curDrawBatch.sampler = this._currSampler;
        curDrawBatch.inputAssembler = ia;
        curDrawBatch.useLocalData = this._currTransform;
        curDrawBatch.textureHash = this._currTextureHash;
        curDrawBatch.samplerHash = this._currSamplerHash;
        curDrawBatch.fillPasses(this._currMaterial, depthStencil, dssHash, blendState, bsHash, null, this);
        curDrawBatch.fillDrawCallAssembler();

        this._batches.push(curDrawBatch);

        buffer.vertexStart = buffer.vertexOffset;
        buffer.indicesStart = buffer.indicesOffset;
        buffer.byteStart = buffer.byteOffset;

        // HACK: After sharing buffer between drawcalls, the performance degradation a lots on iOS 14 or iPad OS 14 device
        // TODO: Maybe it can be removed after Apple fixes it?
        // @ts-expect-error Property '__isWebIOS14OrIPadOS14Env' does not exist on 'sys'
        if (sys.__isWebIOS14OrIPadOS14Env && !this._currIsStatic) {
            this._currMeshBuffer = null;
        }
    }

    /**
     * @en
     * Force changes to current batch data and merge
     *
     * @zh
     * 强行修改当前批次数据并合并。
     *
     * @param material - 当前批次的材质。
     * @param sprite - 当前批次的精灵帧。
     */
    public forceMergeBatches (material: Material, frame: TextureBase | SpriteFrame | null, renderComp: Renderable2D) {
        this._currMaterial = material;

        if (frame) {
            this._currTexture = frame.getGFXTexture();
            this._currSampler = frame.getGFXSampler();
            this._currTextureHash = frame.getHash();
            this._currSamplerHash = this._currSampler.hash;
        } else {
            this._currTexture = this._currSampler = null;
            this._currTextureHash = this._currSamplerHash = 0;
        }
        this._currLayer = renderComp.node.layer;
        this._currScene = renderComp._getRenderScene();
        this.autoMergeBatches(renderComp);
    }

    /**
     * @en
     * Forced to merge the data of the previous batch to start a new batch.
     *
     * @zh
     * 强制合并上一个批次的数据，开启新一轮合批。
     */
    public finishMergeBatches () {
        this.autoMergeBatches();
        this._currMaterial = this._emptyMaterial;
        this._currTexture = null;
        this._currComponent = null;
        this._currTransform = null;
        this._currTextureHash = 0;
        this._currSamplerHash = 0;
        this._currLayer = 0;
    }

    /**
     * @en
     * Force to change the current material.
     *
     * @zh
     * 强制刷新材质。
     */
    public flushMaterial (mat: Material) {
        this._currMaterial = mat;
    }

    public walk (node: Node, level = 0) {
        const len = node.children.length;

        this._preProcess(node);
        if (len > 0 && !node._static) {
            const children = node.children;
            for (let i = 0; i < children.length; ++i) {
                this._currOpacity = node._uiProps.opacity;
                const child = children[i];
                this.walk(child, level);
            }
        }

        this._postProcess(node);

        level += 1;
    }

    private _preProcess (node: Node) {
        const render = node._uiProps.uiComp;
        const localAlpha = node._uiProps.localOpacity;
        node._uiProps.opacity = this._currOpacity * localAlpha;
        if (!node._uiProps.uiTransformComp) {
            return;
        }
        if (render && render.enabledInHierarchy) {
            render.updateAssembler(this);
        }
    }

    private _postProcess (node: Node) {
        const render = node._uiProps.uiComp;
        if (render && render.enabledInHierarchy) {
            render.postUpdateAssembler(this);
        }
    }

    private _recursiveScreenNode (screen: Node) {
        this.walk(screen);
        // macro.UI_GPU_DRIVEN
        if (this._currTypeIsGPU) {
            this.autoMergeBatchesByGPU(this._currComponent!);
        } else {
            this.autoMergeBatches(this._currComponent!);
        }
    }

    private _createMeshBuffer (attributes: Attribute[]): MeshBuffer {
        const batch = this._bufferBatchPool.add();
        batch.initialize(attributes, this._recreateMeshBuffer.bind(this, attributes));
        const strideBytes = VertexFormat.getAttributeStride(attributes);
        let buffers = this._meshBuffers.get(strideBytes);
        if (!buffers) { buffers = []; this._meshBuffers.set(strideBytes, buffers); }
        buffers.push(batch);
        return batch;
    }

    private _recreateMeshBuffer (attributes, vertexCount, indexCount) {
        this.autoMergeBatches();
        this._requireBufferBatch(attributes, vertexCount, indexCount);
    }

    private _requireBufferBatch (attributes: Attribute[], vertexCount?: number, indexCount?: number) {
        const strideBytes = VertexFormat.getAttributeStride(attributes);
        let buffers = this._meshBuffers.get(strideBytes);
        if (!buffers) { buffers = []; this._meshBuffers.set(strideBytes, buffers); }
        let meshBufferUseCount = this._meshBufferUseCount.get(strideBytes) || 0;
        if (vertexCount && indexCount) {
            // useCount++ when _recreateMeshBuffer
            meshBufferUseCount++;
        }

        this._currMeshBuffer = buffers[meshBufferUseCount];
        if (!this._currMeshBuffer) {
            this._currMeshBuffer = this._createMeshBuffer(attributes);
        }
        this._meshBufferUseCount.set(strideBytes, meshBufferUseCount);
        if (vertexCount && indexCount) {
            this._currMeshBuffer.request(vertexCount, indexCount);
        }
    }

    private _screenSort (a: RenderRoot2D, b: RenderRoot2D) {
        return a.node.getSiblingIndex() - b.node.getSiblingIndex();
    }

    private _releaseDescriptorSetCache (textureHash: number) {
        this._descriptorSetCache.releaseDescriptorSetCache(textureHash);
    }

    // macro.UI_GPU_DRIVEN
    private _resetRenderDirty (comp: Renderable2D) {
        comp.node._uiProps.uiTransformComp!._rectDirty = false;
    }
}

class LocalDescriptorSet  {
    private _descriptorSet: DescriptorSet | null = null;
    private _transform: Node | null = null;
    private _textureHash = 0;
    private _samplerHash = 0;
    private _localBuffer: Buffer | null = null;
    private _transformUpdate = true;
    private declare _localData;

    public get descriptorSet (): DescriptorSet | null {
        return this._descriptorSet;
    }

    constructor () {
        const device = legacyCC.director.root.device;
        this._localData = new Float32Array(UBOLocal.COUNT);
        this._localBuffer = device.createBuffer(new BufferInfo(
            BufferUsageBit.UNIFORM | BufferUsageBit.TRANSFER_DST,
            MemoryUsageBit.HOST | MemoryUsageBit.DEVICE,
            UBOLocal.SIZE,
            UBOLocal.SIZE,
        ));
    }

    public initialize (batch) {
        const device = legacyCC.director.root.device;
        this._transform = batch.useLocalData;
        this._textureHash = batch.textureHash;
        this._samplerHash = batch.samplerHash;
        _dsInfo.layout = batch.passes[0].localSetLayout;
        this._descriptorSet =  device.createDescriptorSet(_dsInfo);
        this._descriptorSet!.bindBuffer(UBOLocal.BINDING, this._localBuffer!);
        const binding = ModelLocalBindings.SAMPLER_SPRITE;
        this._descriptorSet!.bindTexture(binding, batch.texture!);
        this._descriptorSet!.bindSampler(binding, batch.sampler!);
        this._descriptorSet!.update();
        this._transformUpdate = true;
    }

    public updateTransform (transform: Node) {
        if (transform === this._transform) return;
        this._transform = transform;
        this._transformUpdate = true;
        this.uploadLocalData();
    }

    public updateLocal () {
        if (!this._transform) return;
        this.uploadLocalData();
    }

    public equals (transform, textureHash, samplerHash) {
        return this._transform === transform && this._textureHash === textureHash && this._samplerHash === samplerHash;
    }

    public reset () {
        this._transform = null;
        this._textureHash = 0;
        this._samplerHash = 0;
    }

    public destroy () {
        if (this._localBuffer) {
            this._localBuffer.destroy();
            this._localBuffer = null;
        }

        if (this._descriptorSet) {
            this._descriptorSet.destroy();
            this._descriptorSet = null;
        }

        this._localData = null;
    }

    private uploadLocalData () {
        const node = this._transform!;
        // @ts-expect-error TS2445
        if (node.hasChangedFlags || node._dirtyFlags) {
            node.updateWorldTransform();
        }
        if (this._transformUpdate) {
            // @ts-expect-error TS2445
            const worldMatrix = node._mat;
            Mat4.toArray(this._localData, worldMatrix, UBOLocal.MAT_WORLD_OFFSET);
            Mat4.inverseTranspose(m4_1, worldMatrix);
            if (!JSB) {
                // fix precision lost of webGL on android device
                // scale worldIT mat to around 1.0 by product its sqrt of determinant.
                const det = Mat4.determinant(m4_1);
                const factor = 1.0 / Math.sqrt(det);
                Mat4.multiplyScalar(m4_1, m4_1, factor);
            }
            Mat4.toArray(this._localData, m4_1, UBOLocal.MAT_WORLD_IT_OFFSET);
            this._localBuffer!.update(this._localData);
            this._transformUpdate = false;
        }
    }
}

class DescriptorSetCache {
    private _descriptorSetCache = new Map<number, DescriptorSet>();
    private _dsCacheHashByTexture = new Map<number, number>();
    private _dsCacheHashByBuffer: number[] = [];
    private _localDescriptorSetCache: LocalDescriptorSet[] = [];
    private _localCachePool: Pool<LocalDescriptorSet>;

    constructor () {
        this._localCachePool = new Pool(() => new LocalDescriptorSet(), 16);
    }

    public getDescriptorSet (batch: DrawBatch2D, drawCall: DrawCall): DescriptorSet {
        const root = legacyCC.director.root;
        let hash;
        if (batch.useLocalData) {
            const caches = this._localDescriptorSetCache;
            for (let i = 0, len = caches.length; i < len; i++) {
                const cache: LocalDescriptorSet = caches[i];
                if (cache.equals(batch.useLocalData, batch.textureHash, batch.samplerHash)) {
                    return cache.descriptorSet!;
                }
            }
            const localDs = this._localCachePool.alloc();
            localDs.initialize(batch);
            this._localDescriptorSetCache.push(localDs);
            return localDs.descriptorSet!;
        } else {
            hash = batch.textureHash ^ batch.samplerHash ^ drawCall.bufferHash;
            if (this._descriptorSetCache.has(hash)) {
                return this._descriptorSetCache.get(hash)!;
            } else {
                const device = legacyCC.director.root.device;
                _dsInfo.layout = batch.passes[0].localSetLayout;
                const descriptorSet = root.device.createDescriptorSet(_dsInfo) as DescriptorSet;
                const binding = ModelLocalBindings.SAMPLER_SPRITE;
                descriptorSet.bindTexture(binding, batch.texture!);
                descriptorSet.bindSampler(binding, batch.sampler!);
                if (!batch.bufferBatch) {
                    const localBufferView = drawCall.bufferView!;
                    descriptorSet.bindBuffer(ModelLocalBindings.UBO_UI_LOCAL, localBufferView);
                }
                descriptorSet.update();

                this._descriptorSetCache.set(hash, descriptorSet);
                this._dsCacheHashByTexture.set(batch.textureHash, hash);
                this._dsCacheHashByBuffer.push(hash);

                return descriptorSet;
            }
        }
    }

    public update () {
        const caches = this._localDescriptorSetCache;
        caches.forEach((value) => {
            value.updateLocal();
        });
    }

    public reset () {
        const caches = this._localDescriptorSetCache;
        caches.forEach((value) => {
            this._localCachePool.free(value);
        });
        this._localDescriptorSetCache.length = 0;
    }

    public releaseDescriptorSetCache (textureHash) {
        const key = this._dsCacheHashByTexture.get(textureHash);
        if (key && this._descriptorSetCache.has(key)) {
            this._descriptorSetCache.get(key)!.destroy();
            this._descriptorSetCache.delete(key);
            this._dsCacheHashByTexture.delete(textureHash);
        }
    }

    public releaseAllByBuffer () {
        const length = this._dsCacheHashByBuffer.length;
        let hash = 0;
        for (let i = 0; i < length; i++) {
            hash = this._dsCacheHashByBuffer[i];
            if (this._descriptorSetCache.has(hash)) {
                this._descriptorSetCache.get(hash)!.destroy();
                this._descriptorSetCache.delete(hash);
            }
        }
        this._dsCacheHashByBuffer.length = 0;
    }

    public destroy () {
        this._descriptorSetCache.forEach((value, key, map) => {
            value.destroy();
        });
        this._descriptorSetCache.clear();
        this._dsCacheHashByTexture.clear();
        this._dsCacheHashByBuffer.length = 0;
        this._localDescriptorSetCache.length = 0;
        this._localCachePool.destroy((obj) => { obj.destroy(); });
    }
}
