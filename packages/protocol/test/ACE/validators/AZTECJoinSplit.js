/* global artifacts, expect, contract, beforeEach, it:true */
// ### External Dependencies
const aztec = require('aztec.js');
const { exceptions } = require('@aztec/dev-utils');
const BN = require('bn.js');
const crypto = require('crypto');
const { padLeft, sha3 } = require('web3-utils');

const { params: { t2 } } = aztec;
const { proof: { joinSplit } } = aztec;

// ### Artifacts
const AZTEC = artifacts.require('./contracts/ACE/validators/AZTECJoinSplit');
const AZTECInterface = artifacts.require('./contracts/ACE/validators/AZTECJoinSplitInterface');


AZTEC.abi = AZTECInterface.abi;

const fakeNetworkId = 100;

function encodeJoinSplitTransaction({
    inputNotes,
    outputNotes,
    senderAddress,
    inputNoteOwners,
    publicOwner,
    kPublic,
    aztecAddress,
}) {
    const m = inputNotes.length;
    const {
        proofData: proofDataRaw,
        challenge,
    } = joinSplit.constructJoinSplitModified([...inputNotes, ...outputNotes], m, senderAddress, kPublic, publicOwner);

    const inputSignatures = inputNotes.map((inputNote, index) => {
        const { privateKey } = inputNoteOwners[index];
        return aztec.sign.signACENote(
            proofDataRaw[index],
            challenge,
            senderAddress,
            aztecAddress,
            privateKey,
            fakeNetworkId
        );
    });
    const outputOwners = outputNotes.map(n => n.owner);
    const proofData = aztec.abiEncoder.joinSplit.encode(
        proofDataRaw,
        m,
        challenge,
        publicOwner,
        inputSignatures,
        outputOwners,
        outputNotes
    );
    const expectedOutput = `0x${aztec.abiEncoder.outputCoder.encodeProofOutputs([{
        inputNotes,
        outputNotes,
        publicOwner,
        publicValue: kPublic,
    }]).slice(0x42)}`;
    return { proofData, expectedOutput };
}

contract('AZTEC', (accounts) => {
    let aztecContract;
    // Creating a collection of tests that should pass
    describe('success states', () => {
        let crs;
        let aztecAccounts = [];
        let notes = [];
        beforeEach(async () => {
            aztecContract = await AZTEC.new(fakeNetworkId, {
                from: accounts[0],
            });
            aztecAccounts = [...new Array(10)].map(() => aztec.secp256k1.generateAccount());
            notes = [
                ...aztecAccounts.map(({ publicKey }, i) => aztec.note.create(publicKey, i * 10)),
                ...aztecAccounts.map(({ publicKey }, i) => aztec.note.create(publicKey, i * 10)),
            ];
            const hx = new BN('7673901602397024137095011250362199966051872585513276903826533215767972925880', 10);
            const hy = new BN('8489654445897228341090914135473290831551238522473825886865492707826370766375', 10);
            crs = [
                `0x${padLeft(hx.toString(16), 64)}`,
                `0x${padLeft(hy.toString(16), 64)}`,
                ...t2,
            ];
        });

        /*
          General structure of the success state unit tests:
          1) Construct the commitments from a selection of k_in and k_out (input and output values)
          2) Generate the proofData and random challenge. Proof data contains notes,
             and each note contains 6 pieces of information:
              a) gamma_x
              b) gamma_y
              c) sigma_x
              d) sigma_y
              e) k^bar
              f) a^bar
              Note: a), b), c) and d) are the Pedersen commitment data
              Note: Syntax to access proof data for one note: proofData[].
              Syntax to access gamma_x for a particular note: proofData[][0]
          3) Validate that these result in a successfull join-split transaction
          4) Calculate the gas used in validating this join-split transaction
          */

        it('succesfully validates an AZTEC JOIN-SPLIT zero-knowledge proof', async () => {
            const inputNotes = notes.slice(2, 4);
            const outputNotes = notes.slice(0, 2);
            const kPublic = 40;
            const publicOwner = aztecAccounts[0].address;
            const { proofData, expectedOutput } = encodeJoinSplitTransaction({
                inputNotes,
                outputNotes,
                senderAddress: accounts[0],
                inputNoteOwners: aztecAccounts.slice(2, 4),
                publicOwner,
                kPublic,
                aztecAddress: aztecContract.address,
            });

            const result = await aztecContract.validateJoinSplit(proofData, accounts[0], crs, {
                from: accounts[0],
                gas: 4000000,
            });
            const decoded = aztec.abiEncoder.outputCoder.decodeProofOutputs(`0x${padLeft('0', 64)}${result.slice(2)}`);
            expect(decoded[0].outputNotes[0].gamma.eq(outputNotes[0].gamma)).to.equal(true);
            expect(decoded[0].outputNotes[0].sigma.eq(outputNotes[0].sigma)).to.equal(true);
            expect(decoded[0].outputNotes[0].noteHash).to.equal(outputNotes[0].noteHash);
            expect(decoded[0].outputNotes[0].owner).to.equal(outputNotes[0].owner.toLowerCase());
            expect(decoded[0].outputNotes[1].gamma.eq(outputNotes[1].gamma)).to.equal(true);
            expect(decoded[0].outputNotes[1].sigma.eq(outputNotes[1].sigma)).to.equal(true);
            expect(decoded[0].outputNotes[1].noteHash).to.equal(outputNotes[1].noteHash);
            expect(decoded[0].outputNotes[1].owner).to.equal(outputNotes[1].owner.toLowerCase());

            expect(decoded[0].inputNotes[0].gamma.eq(inputNotes[0].gamma)).to.equal(true);
            expect(decoded[0].inputNotes[0].sigma.eq(inputNotes[0].sigma)).to.equal(true);
            expect(decoded[0].inputNotes[0].noteHash).to.equal(inputNotes[0].noteHash);
            expect(decoded[0].inputNotes[0].owner).to.equal(inputNotes[0].owner.toLowerCase());
            expect(decoded[0].inputNotes[1].gamma.eq(inputNotes[1].gamma)).to.equal(true);
            expect(decoded[0].inputNotes[1].sigma.eq(inputNotes[1].sigma)).to.equal(true);
            expect(decoded[0].inputNotes[1].noteHash).to.equal(inputNotes[1].noteHash);
            expect(decoded[0].inputNotes[1].owner).to.equal(inputNotes[1].owner.toLowerCase());

            expect(decoded[0].publicOwner).to.equal(publicOwner.toLowerCase());
            expect(decoded[0].publicValue).to.equal(40);
            expect(result).to.equal(expectedOutput);

            const gasUsed = await aztecContract.validateJoinSplit.estimateGas(proofData, accounts[0], crs, {
                from: accounts[0],
                gas: 4000000,
            });
            console.log('gas used = ', gasUsed);
        });

        it('validates proof where kPublic > 0 and kPublic < GROUP_MODULUS/2', async () => {
            const inputNotes = notes.slice(2, 5);
            const outputNotes = notes.slice(0, 2);
            const kPublic = 80;
            const publicOwner = aztecAccounts[0].address;
            const { proofData, expectedOutput } = encodeJoinSplitTransaction({
                inputNotes,
                outputNotes,
                senderAddress: accounts[0],
                inputNoteOwners: aztecAccounts.slice(2, 5),
                publicOwner,
                kPublic,
                aztecAddress: aztecContract.address,
            });

            const result = await aztecContract.validateJoinSplit(proofData, accounts[0], crs, {
                from: accounts[0],
                gas: 4000000,
            });

            expect(result).to.equal(expectedOutput);

            const gasUsed = await aztecContract.validateJoinSplit.estimateGas(proofData, accounts[0], crs, {
                from: accounts[0],
                gas: 4000000,
            });
            console.log('gas used = ', gasUsed);
        });

        it('validates proof where kPublic > GROUP_MODULUS/2', async () => {
            const inputNotes = notes.slice(0, 2);
            const outputNotes = notes.slice(2, 4);
            const kPublic = -40;
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];
            const { proofData, expectedOutput } = encodeJoinSplitTransaction({
                inputNotes,
                outputNotes,
                senderAddress,
                inputNoteOwners: aztecAccounts.slice(0, 2),
                publicOwner,
                kPublic,
                aztecAddress: aztecContract.address,
            });

            const result = await aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });
            expect(result).to.equal(expectedOutput);
            const decoded = aztec.abiEncoder.outputCoder.decodeProofOutputs(`0x${padLeft('0', 64)}${result.slice(2)}`);
            expect(decoded[0].publicValue).to.equal(-40);


            const gasUsed = await aztecContract.validateJoinSplit.estimateGas(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });
            console.log('gas used = ', gasUsed);
        });

        it('validates that large numbers of input/output notes work', async () => {
            const inputNotes = notes.slice(0, 10);
            const outputNotes = notes.slice(10, 20);
            const kPublic = 0;
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];
            const { proofData, expectedOutput } = encodeJoinSplitTransaction({
                inputNotes,
                outputNotes,
                senderAddress,
                inputNoteOwners: aztecAccounts.slice(0, 10),
                publicOwner,
                kPublic,
                aztecAddress: aztecContract.address,
            });

            const result = await aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });
            expect(result).to.equal(expectedOutput);

            const gasUsed = await aztecContract.validateJoinSplit.estimateGas(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });

            console.log('gas used = ', gasUsed);
        });

        it('validate that zero quantity of input notes works', async () => {
            const outputNotes = notes.slice(0, 10);
            const kPublic = -450;
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];
            const { proofData, expectedOutput } = encodeJoinSplitTransaction({
                inputNotes: [],
                outputNotes,
                senderAddress,
                inputNoteOwners: [],
                publicOwner,
                kPublic,
                aztecAddress: aztecContract.address,
            });

            const result = await aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });
            expect(result).to.equal(expectedOutput);

            const gasUsed = await aztecContract.validateJoinSplit.estimateGas(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });

            console.log('gas used = ', gasUsed);
        });

        it('validate that zero quantity of output notes works', async () => {
            const inputNotes = notes.slice(0, 10);
            const kPublic = 450;
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];
            const { proofData, expectedOutput } = encodeJoinSplitTransaction({
                inputNotes,
                outputNotes: [],
                senderAddress,
                inputNoteOwners: aztecAccounts.slice(0, 10),
                publicOwner,
                kPublic,
                aztecAddress: aztecContract.address,
            });

            const result = await aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });
            expect(result).to.equal(expectedOutput);

            const gasUsed = await aztecContract.validateJoinSplit.estimateGas(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });

            console.log('gas used = ', gasUsed);
        });

        it('validate that input notes of zero value work', async () => {
            const inputNotes = [
                aztec.note.create(aztecAccounts[0].publicKey, 0),
                aztec.note.create(aztecAccounts[1].publicKey, 0),
            ];
            const outputNotes = notes.slice(0, 2);
            const kPublic = -10;
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];
            const { proofData, expectedOutput } = encodeJoinSplitTransaction({
                inputNotes,
                outputNotes,
                senderAddress,
                inputNoteOwners: aztecAccounts.slice(0, 10),
                publicOwner,
                kPublic,
                aztecAddress: aztecContract.address,
            });

            const result = await aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });
            expect(result).to.equal(expectedOutput);

            const gasUsed = await aztecContract.validateJoinSplit.estimateGas(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });

            console.log('gas used = ', gasUsed);
        });

        it('validate that output notes of zero value work', async () => {
            const inputNotes = notes.slice(0, 2);
            const outputNotes = [
                aztec.note.create(aztecAccounts[0].publicKey, 0),
                aztec.note.create(aztecAccounts[1].publicKey, 0),
            ];
            const kPublic = 10;
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];
            const { proofData, expectedOutput } = encodeJoinSplitTransaction({
                inputNotes,
                outputNotes,
                senderAddress,
                inputNoteOwners: aztecAccounts.slice(0, 10),
                publicOwner,
                kPublic,
                aztecAddress: aztecContract.address,
            });

            const result = await aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });
            expect(result).to.equal(expectedOutput);

            const gasUsed = await aztecContract.validateJoinSplit.estimateGas(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            });

            console.log('gas used = ', gasUsed);
        });
    });

    describe('failure states', () => {
        let crs;
        let aztecAccounts = [];
        let notes = [];
        beforeEach(async () => {
            aztecContract = await AZTEC.new(fakeNetworkId, {
                from: accounts[0],
            });
            aztecAccounts = [...new Array(10)].map(() => aztec.secp256k1.generateAccount());
            notes = [
                ...aztecAccounts.map(({ publicKey }, i) => aztec.note.create(publicKey, i * 10)),
                ...aztecAccounts.map(({ publicKey }, i) => aztec.note.create(publicKey, i * 10)),
            ];
            const hx = new BN('7673901602397024137095011250362199966051872585513276903826533215767972925880', 10);
            const hy = new BN('8489654445897228341090914135473290831551238522473825886865492707826370766375', 10);
            crs = [
                `0x${padLeft(hx.toString(16), 64)}`,
                `0x${padLeft(hy.toString(16), 64)}`,
                ...t2,
            ];
        });

        it('validates failure when using a fake challenge', async () => {
            const inputNotes = notes.slice(0, 2);
            const outputNotes = [
                aztec.note.create(aztecAccounts[0].publicKey, 0),
                aztec.note.create(aztecAccounts[1].publicKey, 0),
            ];
            const kPublic = 10;
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];
            const { proofData } = encodeJoinSplitTransaction({
                inputNotes,
                outputNotes,
                senderAddress,
                inputNoteOwners: aztecAccounts.slice(0, 10),
                publicOwner,
                kPublic,
                aztecAddress: aztecContract.address,
            });
            const fakeChallenge = padLeft(crypto.randomBytes(32).toString('hex'), 64);

            const fakeProofData = `0x${proofData.slice(0x02, 0x42)}${fakeChallenge}${proofData.slice(0x82)}`;

            exceptions.catchRevert(aztecContract.validateJoinSplit(fakeProofData, senderAddress, crs, {
                from: accounts[0],
                gas: 4000000,
            }));
        });

        it('validates failure for random proof data', async () => {
            const inputNotes = notes.slice(0, 2);
            const outputNotes = [
                aztec.note.create(aztecAccounts[0].publicKey, 0),
                aztec.note.create(aztecAccounts[1].publicKey, 0),
            ];
            const kPublic = 10;
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];
            const m = inputNotes.length;
            const {
                proofData: proofDataRaw,
                challenge,
            } = joinSplit.constructJoinSplitModified([...inputNotes, ...outputNotes], m, senderAddress, kPublic, publicOwner);

            const inputSignatures = inputNotes.map((inputNote, index) => {
                const { privateKey } = aztecAccounts[index];
                return aztec.sign.signACENote(
                    proofDataRaw[index],
                    challenge,
                    senderAddress,
                    aztecContract.address,
                    privateKey,
                    fakeNetworkId
                );
            });
            const outputOwners = outputNotes.map(n => n.owner);
            const fakeProofData = [...Array(4)]
                .map(() => [...Array(6)]
                    .map(() => `0x${padLeft(crypto.randomBytes(32).toString('hex'), 64)}`));

            const proofData = aztec.abiEncoder.joinSplit.encode(
                fakeProofData,
                m,
                challenge,
                publicOwner,
                inputSignatures,
                outputOwners,
                outputNotes
            );

            exceptions.catchRevert(aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: accounts[0],
                gas: 4000000,
            }));
        });

        it('validate failure for zero input note value', async () => {
            const inputNotes = [
                aztec.note.create(aztecAccounts[0].publicKey, 0),
                aztec.note.create(aztecAccounts[1].publicKey, 0),
            ];
            const outputNotes = notes.slice(0, 2);
            const kPublic = 0;
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];
            const m = inputNotes.length;
            const {
                proofData: proofDataRaw,
                challenge,
            } = joinSplit.constructJoinSplitModified([...inputNotes, ...outputNotes], m, senderAddress, kPublic, publicOwner);

            const inputSignatures = inputNotes.map((inputNote, index) => {
                const { privateKey } = aztecAccounts[index];
                return aztec.sign.signACENote(
                    proofDataRaw[index],
                    challenge,
                    senderAddress,
                    aztecContract.address,
                    privateKey,
                    fakeNetworkId
                );
            });
            const outputOwners = outputNotes.map(n => n.owner);

            const proofData = aztec.abiEncoder.joinSplit.encode(
                proofDataRaw,
                m,
                challenge,
                publicOwner,
                inputSignatures,
                outputOwners,
                outputNotes
            );

            exceptions.catchRevert(aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: accounts[0],
                gas: 4000000,
            }));
        });

        it('validate failure for zero ouput note value', async () => {
            const inputNotes = notes.slice(0, 2);
            const outputNotes = [
                aztec.note.create(aztecAccounts[0].publicKey, 0),
                aztec.note.create(aztecAccounts[1].publicKey, 0),
            ];
            const kPublic = 0;
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];
            const m = inputNotes.length;
            const {
                proofData: proofDataRaw,
                challenge,
            } = joinSplit.constructJoinSplitModified([...inputNotes, ...outputNotes], m, senderAddress, kPublic, publicOwner);

            const inputSignatures = inputNotes.map((inputNote, index) => {
                const { privateKey } = aztecAccounts[index];
                return aztec.sign.signACENote(
                    proofDataRaw[index],
                    challenge,
                    senderAddress,
                    aztecContract.address,
                    privateKey,
                    fakeNetworkId
                );
            });
            const outputOwners = outputNotes.map(n => n.owner);
            const proofData = aztec.abiEncoder.joinSplit.encode(
                proofDataRaw,
                m,
                challenge,
                publicOwner,
                inputSignatures,
                outputOwners,
                outputNotes
            );

            exceptions.catchRevert(aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: accounts[0],
                gas: 4000000,
            }));
        });

        it('validate failure when using a fake trusted setup key', async () => {
            const {
                commitments,
                m,
            } = joinSplit.helpers.generateFakeCommitmentSet({
                kIn: [11, 22],
                kOut: [5, 28],
            });
            const publicOwner = aztecAccounts[0].address;
            const senderAddress = accounts[0];

            const {
                proofData: proofDataRaw,
                challenge,
            } = joinSplit.constructJoinSplitModified(commitments, m, accounts[0], 0, publicOwner);

            const inputSignatures = commitments.slice(0, 2).map((inputNote, index) => {
                const { privateKey } = aztecAccounts[index];
                return aztec.sign.signACENote(
                    proofDataRaw[index],
                    challenge,
                    senderAddress,
                    aztecContract.address,
                    privateKey,
                    fakeNetworkId
                );
            });
            const outputOwners = aztecAccounts.slice(2, 4).map(a => a.address);
            const proofData = aztec.abiEncoder.joinSplit.encode(
                proofDataRaw,
                m,
                challenge,
                publicOwner,
                inputSignatures,
                outputOwners,
                notes.slice(0, 2)
            );

            exceptions.catchRevert(aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            }));
        });

        it('validate failure when points not on curve', async () => {
            const zeroes = `${padLeft('0', 64)}`;
            const noteString = `${zeroes}${zeroes}${zeroes}${zeroes}${zeroes}${zeroes}`;
            const challengeString = `0x${padLeft(accounts[0].slice(2), 64)}${padLeft('132', 64)}${padLeft('1', 64)}${noteString}`;
            const challenge = sha3(challengeString, 'hex');
            const m = 1;
            const proofDataRaw = [[`0x${padLeft('132', 64)}`, '0x0', '0x0', '0x0', '0x0', '0x0']];
            const senderAddress = accounts[0];
            const inputSignatures = [
                aztec.sign.signACENote(
                    proofDataRaw[0],
                    challenge,
                    senderAddress,
                    aztecContract.address,
                    aztecAccounts[0].privateKey,
                    fakeNetworkId
                ),
            ];
            const outputOwners = [];
            const publicOwner = aztecAccounts[0].address;
            const proofData = aztec.abiEncoder.joinSplit.encode(
                proofDataRaw,
                m,
                challenge,
                publicOwner,
                inputSignatures,
                outputOwners,
                []
            );
            await exceptions.catchRevert(aztecContract.validateJoinSplit(proofData, senderAddress, crs, {
                from: senderAddress,
                gas: 4000000,
            }));
        });
    });
});
