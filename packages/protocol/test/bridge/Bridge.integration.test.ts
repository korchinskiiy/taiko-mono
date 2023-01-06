import { expect } from "chai";
import { BigNumber } from "ethers";
import hre, { ethers } from "hardhat";
import {
    getLatestBlockHeader,
    getSignalProof,
    getSignalSlot,
} from "../../tasks/utils";
import {
    AddressManager,
    TestBadReceiver,
    TestHeaderSync,
    TestLibBridgeData,
} from "../../typechain";
import { deployBridge } from "../utils/bridge";
import { Message } from "../utils/message";

describe("integration:Bridge", function () {
    async function deployBridgeFixture() {
        const [owner, nonOwner] = await ethers.getSigners();

        const { chainId } = await ethers.provider.getNetwork();

        const srcChainId = chainId;

        // seondary node to deploy L2 on
        const l2Provider = new ethers.providers.JsonRpcProvider(
            "http://localhost:28545"
        );

        const l2Signer = await l2Provider.getSigner(
            (
                await l2Provider.listAccounts()
            )[0]
        );

        const l2NonOwner = await l2Provider.getSigner();

        const l2Network = await l2Provider.getNetwork();
        const enabledDestChainId = l2Network.chainId;

        const addressManager: AddressManager = await (
            await ethers.getContractFactory("AddressManager")
        ).deploy();
        await addressManager.init();

        const l2AddressManager: AddressManager = await (
            await ethers.getContractFactory("AddressManager")
        )
            .connect(l2Signer)
            .deploy();
        await l2AddressManager.init();

        const { bridge: l1Bridge, etherVault: l1EtherVault } =
            await deployBridge(
                owner,
                addressManager,
                enabledDestChainId,
                srcChainId
            );

        const { bridge: l2Bridge, etherVault: l2EtherVault } =
            await deployBridge(
                l2Signer,
                l2AddressManager,
                srcChainId,
                enabledDestChainId
            );

        await addressManager.setAddress(
            `${enabledDestChainId}.bridge`,
            l2Bridge.address
        );

        await l2AddressManager
            .connect(l2Signer)
            .setAddress(`${srcChainId}.bridge`, l1Bridge.address);

        const headerSync: TestHeaderSync = await (
            await ethers.getContractFactory("TestHeaderSync")
        )
            .connect(l2Signer)
            .deploy();

        await l2AddressManager
            .connect(l2Signer)
            .setAddress(`${enabledDestChainId}.taiko`, headerSync.address);

        const m: Message = {
            id: 1,
            sender: owner.address,
            srcChainId: srcChainId,
            destChainId: enabledDestChainId,
            owner: owner.address,
            to: owner.address,
            refundAddress: owner.address,
            depositValue: 1000,
            callValue: 1000,
            processingFee: 1000,
            gasLimit: 10000,
            data: ethers.constants.HashZero,
            memo: "",
        };

        return {
            owner,
            l2Signer,
            nonOwner,
            l2NonOwner,
            l1Bridge,
            l2Bridge,
            addressManager,
            enabledDestChainId,
            l1EtherVault,
            l2EtherVault,
            srcChainId,
            headerSync,
            m,
        };
    }

    describe("processMessage()", function () {
        it("should throw if message.gasLimit == 0 & msg.sender is not message.owner", async function () {
            const {
                owner,
                l2NonOwner,
                srcChainId,
                enabledDestChainId,
                l2Bridge,
            } = await deployBridgeFixture();

            const m: Message = {
                id: 1,
                sender: await l2NonOwner.getAddress(),
                srcChainId: srcChainId,
                destChainId: enabledDestChainId,
                owner: owner.address,
                to: owner.address,
                refundAddress: owner.address,
                depositValue: 1000,
                callValue: 1000,
                processingFee: 1000,
                gasLimit: 0,
                data: ethers.constants.HashZero,
                memo: "",
            };

            await expect(
                l2Bridge.processMessage(m, ethers.constants.HashZero)
            ).to.be.revertedWith("B:forbidden");
        });

        it("should throw if message.destChainId is not equal to current block.chainId", async function () {
            const { owner, srcChainId, enabledDestChainId, l2Bridge } =
                await deployBridgeFixture();

            const m: Message = {
                id: 1,
                sender: owner.address,
                srcChainId: srcChainId,
                destChainId: enabledDestChainId + 1,
                owner: owner.address,
                to: owner.address,
                refundAddress: owner.address,
                depositValue: 1000,
                callValue: 1000,
                processingFee: 1000,
                gasLimit: 10000,
                data: ethers.constants.HashZero,
                memo: "",
            };

            await expect(
                l2Bridge.processMessage(m, ethers.constants.HashZero)
            ).to.be.revertedWith("B:destChainId");
        });

        it("should throw if messageStatus of message is != NEW", async function () {
            const { l1Bridge, l2Bridge, headerSync, m } =
                await deployBridgeFixture();

            const expectedAmount =
                m.depositValue + m.callValue + m.processingFee;
            const tx = await l1Bridge.sendMessage(m, {
                value: expectedAmount,
            });

            const receipt = await tx.wait();

            const [messageSentEvent] = receipt.events as any as Event[];

            const { signal, message } = (messageSentEvent as any).args;

            const sender = l1Bridge.address;

            const key = getSignalSlot(hre, sender, signal);

            const { block, blockHeader } = await getLatestBlockHeader(hre);

            await headerSync.setSyncedHeader(block.hash);

            const signalProof = await getSignalProof(
                hre,
                l1Bridge.address,
                key,
                block.number,
                blockHeader
            );

            // upon successful processing, this immediately gets marked as DONE
            await l2Bridge.processMessage(message, signalProof);

            // recalling this process should be prevented as it's status is no longer NEW
            await expect(
                l2Bridge.processMessage(message, signalProof)
            ).to.be.revertedWith("B:status");
        });

        it("should throw if message signalproof is not valid", async function () {
            const { l1Bridge, l2Bridge, headerSync, m } =
                await deployBridgeFixture();

            const libData: TestLibBridgeData = await (
                await ethers.getContractFactory("TestLibBridgeData")
            ).deploy();

            const signal = await libData.hashMessage(m);

            const sender = l1Bridge.address;

            const key = getSignalSlot(hre, sender, signal);
            const { block, blockHeader } = await getLatestBlockHeader(hre);

            await headerSync.setSyncedHeader(ethers.constants.HashZero);

            const signalProof = await getSignalProof(
                hre,
                l1Bridge.address,
                key,
                block.number,
                blockHeader
            );

            await expect(
                l2Bridge.processMessage(m, signalProof)
            ).to.be.revertedWith("LTP:invalid storage proof");
        });

        it("should throw if message has not been received", async function () {
            const { l1Bridge, l2Bridge, headerSync, m } =
                await deployBridgeFixture();

            const expectedAmount =
                m.depositValue + m.callValue + m.processingFee;
            const tx = await l1Bridge.sendMessage(m, {
                value: expectedAmount,
            });

            const receipt = await tx.wait();

            const [messageSentEvent] = receipt.events as any as Event[];

            const { signal, message } = (messageSentEvent as any).args;

            expect(signal).not.to.be.eq(ethers.constants.HashZero);

            const messageStatus = await l1Bridge.getMessageStatus(signal);

            expect(messageStatus).to.be.eq(0);

            const sender = l1Bridge.address;

            const key = getSignalSlot(hre, sender, signal);

            const { block, blockHeader } = await getLatestBlockHeader(hre);

            await headerSync.setSyncedHeader(ethers.constants.HashZero);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1Bridge.address,
                key,
                block.number
            );
            // make sure it equals 1 so our proof will pass
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre,
                l1Bridge.address,
                key,
                block.number,
                blockHeader
            );

            await expect(
                l2Bridge.processMessage(message, signalProof)
            ).to.be.revertedWith("B:notReceived");
        });

        it("processes a message when the signal has been verified from the sending chain", async () => {
            const { l1Bridge, l2Bridge, headerSync, m } =
                await deployBridgeFixture();

            const expectedAmount =
                m.depositValue + m.callValue + m.processingFee;
            const tx = await l1Bridge.sendMessage(m, {
                value: expectedAmount,
            });

            const receipt = await tx.wait();

            const [messageSentEvent] = receipt.events as any as Event[];

            const { signal, message } = (messageSentEvent as any).args;

            expect(signal).not.to.be.eq(ethers.constants.HashZero);

            const messageStatus = await l1Bridge.getMessageStatus(signal);

            expect(messageStatus).to.be.eq(0);

            const sender = l1Bridge.address;

            const key = getSignalSlot(hre, sender, signal);

            const { block, blockHeader } = await getLatestBlockHeader(hre);

            await headerSync.setSyncedHeader(block.hash);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1Bridge.address,
                key,
                block.number
            );
            // make sure it equals 1 so our proof will pass
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre,
                l1Bridge.address,
                key,
                block.number,
                blockHeader
            );

            expect(
                await l2Bridge.processMessage(message, signalProof, {
                    gasLimit: BigNumber.from(2000000),
                })
            ).to.emit(l2Bridge, "MessageStatusChanged");
        });
    });

    describe("isMessageSent()", function () {
        it("should return false, since no message was sent", async function () {
            const { l1Bridge, m } = await deployBridgeFixture();

            const libData = await (
                await ethers.getContractFactory("TestLibBridgeData")
            ).deploy();
            const signal = await libData.hashMessage(m);

            expect(await l1Bridge.isMessageSent(signal)).to.be.eq(false);
        });

        it("should return true if message was sent properly", async function () {
            const { l1Bridge, m } = await deployBridgeFixture();

            const expectedAmount =
                m.depositValue + m.callValue + m.processingFee;
            const tx = await l1Bridge.sendMessage(m, {
                value: expectedAmount,
            });

            const receipt = await tx.wait();

            const [messageSentEvent] = receipt.events as any as Event[];

            const { signal } = (messageSentEvent as any).args;

            expect(signal).not.to.be.eq(ethers.constants.HashZero);

            expect(await l1Bridge.isMessageSent(signal)).to.be.eq(true);
        });
    });

    describe("retryMessage()", function () {
        async function retriableMessageSetup() {
            const {
                owner,
                l2Signer,
                nonOwner,
                l2NonOwner,
                l1Bridge,
                l2Bridge,
                addressManager,
                enabledDestChainId,
                l1EtherVault,
                l2EtherVault,
                srcChainId,
                headerSync,
            } = await deployBridgeFixture();

            const testBadReceiver: TestBadReceiver = await (
                await ethers.getContractFactory("TestBadReceiver")
            )
                .connect(l2Signer)
                .deploy();

            await testBadReceiver.deployed();

            const m: Message = {
                id: 1,
                sender: owner.address,
                srcChainId: srcChainId,
                destChainId: enabledDestChainId,
                owner: owner.address,
                to: testBadReceiver.address,
                refundAddress: owner.address,
                depositValue: 1000,
                callValue: 1000,
                processingFee: 1000,
                gasLimit: 1,
                data: ethers.constants.HashZero,
                memo: "",
            };

            const expectedAmount =
                m.depositValue + m.callValue + m.processingFee;
            const tx = await l1Bridge.connect(owner).sendMessage(m, {
                value: expectedAmount,
            });

            const receipt = await tx.wait();

            const [messageSentEvent] = receipt.events as any as Event[];

            const { signal, message } = (messageSentEvent as any).args;

            expect(signal).not.to.be.eq(ethers.constants.HashZero);

            const messageStatus = await l1Bridge.getMessageStatus(signal);

            expect(messageStatus).to.be.eq(0);

            const sender = l1Bridge.address;

            const key = getSignalSlot(hre, sender, signal);

            const { block, blockHeader } = await getLatestBlockHeader(hre);

            await headerSync.setSyncedHeader(block.hash);

            const signalProof = await getSignalProof(
                hre,
                l1Bridge.address,
                key,
                block.number,
                blockHeader
            );

            await l2Bridge
                .connect(l2NonOwner)
                .processMessage(message, signalProof, {
                    gasLimit: BigNumber.from(2000000),
                });

            const status = await l2Bridge.getMessageStatus(signal);
            expect(status).to.be.eq(1); // message is retriable now
            // because the LibBridgeInvoke call failed, because
            // message.to is a bad receiver and throws upon receipt

            return {
                message,
                l2Signer,
                l2NonOwner,
                l1Bridge,
                l2Bridge,
                addressManager,
                headerSync,
                owner,
                nonOwner,
                srcChainId,
                enabledDestChainId,
                l1EtherVault,
                l2EtherVault,
                signal,
            };
        }
        it("setup message to fail first processMessage", async function () {
            const { l2Bridge, signal } = await retriableMessageSetup();
            l2Bridge;
            signal;
        });
    });

    describe("isMessageReceived()", function () {
        it("should throw if signal is not a bridge message; proof is invalid since sender != bridge.", async function () {
            const { owner, l1Bridge, l2Bridge, headerSync, srcChainId } =
                await deployBridgeFixture();

            const signal = ethers.utils.hexlify(ethers.utils.randomBytes(32));

            const tx = await l1Bridge.connect(owner).sendSignal(signal);

            await tx.wait();

            const sender = owner.address;

            const key = getSignalSlot(hre, sender, signal);

            const { block, blockHeader } = await getLatestBlockHeader(hre);

            await headerSync.setSyncedHeader(block.hash);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1Bridge.address,
                key,
                block.number
            );
            // // make sure it equals 1 so we know sendSignal worked
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre,
                l1Bridge.address,
                key,
                block.number,
                blockHeader
            );

            await expect(
                l2Bridge.isMessageReceived(signal, srcChainId, signalProof)
            ).to.be.reverted;
        });

        it("should return true", async function () {
            const { l1Bridge, srcChainId, l2Bridge, headerSync, m } =
                await deployBridgeFixture();

            const expectedAmount =
                m.depositValue + m.callValue + m.processingFee;
            const tx = await l1Bridge.sendMessage(m, {
                value: expectedAmount,
            });

            const receipt = await tx.wait();

            const [messageSentEvent] = receipt.events as any as Event[];

            const { signal } = (messageSentEvent as any).args;

            const sender = l1Bridge.address;

            const key = getSignalSlot(hre, sender, signal);

            const { block, blockHeader } = await getLatestBlockHeader(hre);

            await headerSync.setSyncedHeader(block.hash);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1Bridge.address,
                key,
                block.number
            );
            // // make sure it equals 1 so we know sendMessage worked
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre,
                l1Bridge.address,
                key,
                block.number,
                blockHeader
            );

            expect(
                await l2Bridge.isMessageReceived(
                    signal,
                    srcChainId,
                    signalProof
                )
            ).to.be.eq(true);
        });
    });

    describe("isSignalReceived()", function () {
        it("should throw if sender == address(0)", async function () {
            const { l2Bridge, srcChainId } = await deployBridgeFixture();

            const signal = ethers.utils.randomBytes(32);
            const sender = ethers.constants.AddressZero;
            const signalProof = ethers.constants.HashZero;

            await expect(
                l2Bridge.isSignalReceived(
                    signal,
                    srcChainId,
                    sender,
                    signalProof
                )
            ).to.be.revertedWith("B:sender");
        });

        it("should throw if signal == HashZero", async function () {
            const { owner, l2Bridge, srcChainId } = await deployBridgeFixture();

            const signal = ethers.constants.HashZero;
            const sender = owner.address;
            const signalProof = ethers.constants.HashZero;

            await expect(
                l2Bridge.isSignalReceived(
                    signal,
                    srcChainId,
                    sender,
                    signalProof
                )
            ).to.be.revertedWith("B:signal");
        });

        it("should throw if calling from same layer", async function () {
            const { owner, l1Bridge, headerSync, srcChainId } =
                await deployBridgeFixture();
            const signal = ethers.utils.hexlify(ethers.utils.randomBytes(32));

            const tx = await l1Bridge.connect(owner).sendSignal(signal);

            await tx.wait();

            const sender = owner.address;

            const key = getSignalSlot(hre, sender, signal);

            const { block, blockHeader } = await getLatestBlockHeader(hre);

            await headerSync.setSyncedHeader(block.hash);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1Bridge.address,
                key,
                block.number
            );
            // make sure it equals 1 so our proof is valid
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre,
                l1Bridge.address,
                key,
                block.number,
                blockHeader
            );

            await expect(
                l1Bridge.isSignalReceived(
                    signal,
                    srcChainId,
                    sender,
                    signalProof
                )
            ).to.be.revertedWith("B:srcBridge");
        });

        it("should return true and pass", async function () {
            const { owner, l1Bridge, l2Bridge, headerSync, srcChainId } =
                await deployBridgeFixture();

            const signal = ethers.utils.hexlify(ethers.utils.randomBytes(32));

            const tx = await l1Bridge.connect(owner).sendSignal(signal);

            await tx.wait();

            const sender = owner.address;

            const key = getSignalSlot(hre, sender, signal);

            const { block, blockHeader } = await getLatestBlockHeader(hre);

            await headerSync.setSyncedHeader(block.hash);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1Bridge.address,
                key,
                block.number
            );
            // make sure it equals 1 so our proof will pass
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre,
                l1Bridge.address,
                key,
                block.number,
                blockHeader
            );
            // proving functionality; l2Bridge can check if l1Bridge receives a signal
            // allowing for dapp cross layer communication
            expect(
                await l2Bridge.isSignalReceived(
                    signal,
                    srcChainId,
                    sender,
                    signalProof
                )
            ).to.be.eq(true);
        });
    });
});
