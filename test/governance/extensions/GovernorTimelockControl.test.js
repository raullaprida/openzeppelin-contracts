const { ethers } = require('hardhat');
const { expect } = require('chai');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const { PANIC_CODES } = require('@nomicfoundation/hardhat-chai-matchers/panic');

const { GovernorHelper, timelockSalt } = require('../../helpers/governance');
const { OperationState, ProposalState, VoteType } = require('../../helpers/enums');
const time = require('../../helpers/time');

const TOKENS = [
  { Token: '$ERC20Votes', mode: 'blocknumber' },
  { Token: '$ERC20VotesTimestampMock', mode: 'timestamp' },
];

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const PROPOSER_ROLE = ethers.id('PROPOSER_ROLE');
const EXECUTOR_ROLE = ethers.id('EXECUTOR_ROLE');
const CANCELLER_ROLE = ethers.id('CANCELLER_ROLE');

const name = 'OZ-Governor';
const version = '1';
const tokenName = 'MockToken';
const tokenSymbol = 'MTKN';
const tokenSupply = ethers.parseEther('100');
const votingDelay = 4n;
const votingPeriod = 16n;
const value = ethers.parseEther('1');
const delay = time.duration.hours(1n);

describe('GovernorTimelockControl', function () {
  for (const { Token, mode } of TOKENS) {
    const fixture = async () => {
      const [deployer, owner, voter1, voter2, voter3, voter4, other] = await ethers.getSigners();
      const receiver = await ethers.deployContract('CallReceiverMock');

      const token = await ethers.deployContract(Token, [tokenName, tokenSymbol, version]);
      const timelock_1 = await ethers.deployContract('TimelockController', [delay, [], [], deployer]);
      const timelock_2 = await ethers.deployContract('TimelockController', [delay, [], [], deployer]);
      const executor = await ethers.deployContract('ProposalExecutor', [[timelock_1.target, timelock_2.target]]);
      const mock = await ethers.deployContract('$GovernorTimelockControlMock', [
        name,
        votingDelay,
        votingPeriod,
        0n,
        executor,
        token,
        0n,
      ]);

      await owner.sendTransaction({ to: timelock_1, value });
      await owner.sendTransaction({ to: timelock_2, value });

      await token.$_mint(owner, tokenSupply);
      await timelock_1.grantRole(PROPOSER_ROLE, executor);
      await timelock_1.grantRole(PROPOSER_ROLE, owner);
      await timelock_1.grantRole(CANCELLER_ROLE, executor);
      await timelock_1.grantRole(CANCELLER_ROLE, owner);
      await timelock_1.grantRole(EXECUTOR_ROLE, ethers.ZeroAddress);
      await timelock_1.revokeRole(DEFAULT_ADMIN_ROLE, deployer);

      await timelock_2.grantRole(PROPOSER_ROLE, executor);
      await timelock_2.grantRole(PROPOSER_ROLE, owner);
      await timelock_2.grantRole(CANCELLER_ROLE, executor);
      await timelock_2.grantRole(CANCELLER_ROLE, owner);
      await timelock_2.grantRole(EXECUTOR_ROLE, ethers.ZeroAddress);
      await timelock_2.revokeRole(DEFAULT_ADMIN_ROLE, deployer);

      const helper = new GovernorHelper(mock, mode);
      await helper.connect(owner).delegate({ token, to: voter1, value: ethers.parseEther('10') });
      await helper.connect(owner).delegate({ token, to: voter2, value: ethers.parseEther('7') });
      await helper.connect(owner).delegate({ token, to: voter3, value: ethers.parseEther('5') });
      await helper.connect(owner).delegate({ token, to: voter4, value: ethers.parseEther('2') });

      return {
        deployer,
        owner,
        voter1,
        voter2,
        voter3,
        voter4,
        other,
        receiver,
        token,
        mock,
        timelock_1,
        timelock_2,
        helper,
        executor,
      };
    };

    describe(`using ${Token}`, function () {
      beforeEach(async function () {
        Object.assign(this, await loadFixture(fixture));

        // default proposal
        this.proposal = this.helper.setProposal(
          [
            {
              target: this.receiver.target,
              value,
              data: this.receiver.interface.encodeFunctionData('mockFunction'),
            },
          ],
          '<proposal description>',
        );

        this.proposal.timelockid = await this.timelock_1.hashOperationBatch(
          ...this.proposal.shortProposal.slice(0, 3),
          ethers.ZeroHash,
          timelockSalt(this.mock.target, this.proposal.shortProposal[3]),
        );
      });

      it("doesn't accept ether transfers", async function () {
        await expect(this.owner.sendTransaction({ to: this.mock, value: 1n })).to.be.revertedWithCustomError(
          this.mock,
          'GovernorDisabledDeposit',
        );
      });

      it('post deployment check', async function () {
        expect(await this.mock.name()).to.equal(name);
        expect(await this.mock.token()).to.equal(this.token);
        expect(await this.mock.votingDelay()).to.equal(votingDelay);
        expect(await this.mock.votingPeriod()).to.equal(votingPeriod);
        expect(await this.mock.quorum(0n)).to.equal(0n);

        expect(await this.mock.timelock()).to.equal(this.executor);
      });

      it('nominal', async function () {
        expect(await this.mock.proposalEta(this.proposal.id)).to.equal(0n);
        expect(await this.mock.proposalNeedsQueuing(this.proposal.id)).to.be.true;

        await this.helper.propose();
        await this.helper.waitForSnapshot();
        await this.helper.connect(this.voter1).vote({ support: VoteType.For });
        await this.helper.connect(this.voter2).vote({ support: VoteType.For });
        await this.helper.connect(this.voter3).vote({ support: VoteType.Against });
        await this.helper.connect(this.voter4).vote({ support: VoteType.Abstain });
        await this.helper.waitForDeadline();

        expect(await this.mock.proposalNeedsQueuing(this.proposal.id)).to.be.true;
        const txQueue = await this.helper.queue();

        const eta = (await time.clockFromReceipt.timestamp(txQueue)) + delay;
        expect(await this.mock.proposalEta(this.proposal.id)).to.equal(eta);
        await this.helper.waitForEta();

        const txExecute = this.helper.execute();

        await expect(txQueue)
          .to.emit(this.mock, 'ProposalQueued')
          .withArgs(this.proposal.id, anyValue)
          .to.emit(this.timelock_1, 'CallScheduled')
          .withArgs(this.proposal.timelockid, ...Array(6).fill(anyValue))
          .to.emit(this.timelock_1, 'CallSalt')
          .withArgs(this.proposal.timelockid, anyValue);

        await expect(txExecute)
          .to.emit(this.mock, 'ProposalExecuted')
          .withArgs(this.proposal.id)
          .to.emit(this.timelock_1, 'CallExecuted')
          .withArgs(this.proposal.timelockid, ...Array(4).fill(anyValue))
          .to.emit(this.receiver, 'MockFunctionCalled');
      });

      describe('should revert', function () {
        describe('on queue', function () {
          it('if already queued', async function () {
            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline();
            await this.helper.queue();
            await expect(this.helper.queue())
              .to.be.revertedWithCustomError(this.mock, 'GovernorUnexpectedProposalState')
              .withArgs(
                this.proposal.id,
                ProposalState.Queued,
                GovernorHelper.proposalStatesToBitMap([ProposalState.Succeeded]),
              );
          });
          it('[multi_bucket]: NOT revert since not already queued', async function () {
            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline();
            await this.helper.queue();
            await this.helper.modifyProposalType(1);
            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline();
            //ProposalQueued
            await expect(this.helper.queue()).to.emit(this.mock, 'ProposalQueued').withArgs(this.proposal.id, anyValue);
          });
        });

        describe('on execute', function () {
          it('if not queued', async function () {
            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline(1n);

            expect(await this.mock.state(this.proposal.id)).to.equal(ProposalState.Succeeded);

            await expect(this.helper.execute())
              .to.be.revertedWithCustomError(this.timelock_1, 'TimelockUnexpectedOperationState')
              .withArgs(this.proposal.timelockid, GovernorHelper.proposalStatesToBitMap(OperationState.Ready));
          });

          it('if too early', async function () {
            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline();
            await this.helper.queue();

            expect(await this.mock.state(this.proposal.id)).to.equal(ProposalState.Queued);

            await expect(this.helper.execute())
              .to.be.revertedWithCustomError(this.timelock_1, 'TimelockUnexpectedOperationState')
              .withArgs(this.proposal.timelockid, GovernorHelper.proposalStatesToBitMap(OperationState.Ready));
          });

          it('if already executed', async function () {
            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline();
            await this.helper.queue();
            await this.helper.waitForEta();
            await this.helper.execute();

            await expect(this.helper.execute())
              .to.be.revertedWithCustomError(this.mock, 'GovernorUnexpectedProposalState')
              .withArgs(
                this.proposal.id,
                ProposalState.Executed,
                GovernorHelper.proposalStatesToBitMap([ProposalState.Succeeded, ProposalState.Queued]),
              );
          });

          it('if already executed by another proposer', async function () {
            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline();
            await this.helper.queue();
            await this.helper.waitForEta();

            await this.timelock_1.executeBatch(
              ...this.proposal.shortProposal.slice(0, 3),
              ethers.ZeroHash,
              timelockSalt(this.mock.target, this.proposal.shortProposal[3]),
            );

            await expect(this.helper.execute())
              .to.be.revertedWithCustomError(this.mock, 'GovernorUnexpectedProposalState')
              .withArgs(
                this.proposal.id,
                ProposalState.Executed,
                GovernorHelper.proposalStatesToBitMap([ProposalState.Succeeded, ProposalState.Queued]),
              );
          });
        });
      });

      describe('cancel', function () {
        it('cancel before queue prevents scheduling', async function () {
          await this.helper.propose();
          await this.helper.waitForSnapshot();
          await this.helper.connect(this.voter1).vote({ support: VoteType.For });
          await this.helper.waitForDeadline();

          await expect(this.helper.cancel('internal'))
            .to.emit(this.mock, 'ProposalCanceled')
            .withArgs(this.proposal.id);

          expect(await this.mock.state(this.proposal.id)).to.equal(ProposalState.Canceled);

          await expect(this.helper.queue())
            .to.be.revertedWithCustomError(this.mock, 'GovernorUnexpectedProposalState')
            .withArgs(
              this.proposal.id,
              ProposalState.Canceled,
              GovernorHelper.proposalStatesToBitMap([ProposalState.Succeeded]),
            );
        });

        it('cancel after queue prevents executing', async function () {
          await this.helper.propose();
          await this.helper.waitForSnapshot();
          await this.helper.connect(this.voter1).vote({ support: VoteType.For });
          await this.helper.waitForDeadline();
          await this.helper.queue();

          await expect(this.helper.cancel('internal'))
            .to.emit(this.mock, 'ProposalCanceled')
            .withArgs(this.proposal.id);

          expect(await this.mock.state(this.proposal.id)).to.equal(ProposalState.Canceled);

          await expect(this.helper.execute())
            .to.be.revertedWithCustomError(this.mock, 'GovernorUnexpectedProposalState')
            .withArgs(
              this.proposal.id,
              ProposalState.Canceled,
              GovernorHelper.proposalStatesToBitMap([ProposalState.Succeeded, ProposalState.Queued]),
            );
        });

        it('[multi-bucket] cancel proposal from other bucket after queue does not prevent executing', async function () {
          await this.helper.modifyProposalType(0);
          await this.helper.propose();
          await this.helper.waitForSnapshot();
          await this.helper.connect(this.voter1).vote({ support: VoteType.For });
          await this.helper.waitForDeadline();
          await this.helper.queue();

          await this.helper.modifyProposalType(1);
          await this.helper.propose();
          await this.helper.waitForSnapshot();
          await this.helper.connect(this.voter1).vote({ support: VoteType.For });
          await this.helper.waitForDeadline();
          await this.helper.queue();

          await expect(this.helper.cancel('internal')).to.emit(this.mock, 'ProposalCanceled').withArgs(this.helper.id);

          expect(await this.mock.state(this.helper.id)).to.equal(ProposalState.Canceled);
          console.log(this.helper.propType);

          await this.helper.modifyProposalType(0);
          await this.helper.waitForEta();
          await expect(this.helper.execute()).to.emit(this.mock, 'ProposalExecuted').withArgs(this.helper.id);
        });

        it('cancel on timelock is reflected on governor', async function () {
          await this.helper.propose();
          await this.helper.waitForSnapshot();
          await this.helper.connect(this.voter1).vote({ support: VoteType.For });
          await this.helper.waitForDeadline();
          await this.helper.queue();

          expect(await this.mock.state(this.proposal.id)).to.equal(ProposalState.Queued);

          await expect(this.timelock_1.connect(this.owner).cancel(this.proposal.timelockid))
            .to.emit(this.timelock_1, 'Cancelled')
            .withArgs(this.proposal.timelockid);

          expect(await this.mock.state(this.proposal.id)).to.equal(ProposalState.Canceled);
        });
      });

      describe('onlyGovernance', function () {
        describe('relay', function () {
          beforeEach(async function () {
            await this.token.$_mint(this.mock, 1);
          });

          it('is protected', async function () {
            await expect(
              this.mock
                .connect(this.owner)
                .relay(this.token, 0n, this.token.interface.encodeFunctionData('transfer', [this.other.address, 1n])),
            )
              .to.be.revertedWithCustomError(this.mock, 'GovernorOnlyExecutor')
              .withArgs(this.owner);
          });

          it('can be executed through governance', async function () {
            this.helper.setProposal(
              [
                {
                  target: this.mock.target,
                  data: this.mock.interface.encodeFunctionData('relay', [
                    this.token.target,
                    0n,
                    this.token.interface.encodeFunctionData('transfer', [this.other.address, 1n]),
                  ]),
                  propType: '0',
                },
              ],
              '<proposal description>',
            );

            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline();
            await this.helper.queue();
            await this.helper.waitForEta();

            const txExecute = await this.helper.execute();

            await expect(txExecute).to.changeTokenBalances(this.token, [this.mock, this.other], [-1n, 1n]);

            await expect(txExecute).to.emit(this.token, 'Transfer').withArgs(this.mock, this.other, 1n);
          });

          it('is payable and can transfer eth to EOA', async function () {
            const t2g = 128n; // timelock to governor
            const g2o = 100n; // governor to eoa (other)

            this.helper.setProposal(
              [
                {
                  target: this.mock.target,
                  value: t2g,
                  data: this.mock.interface.encodeFunctionData('relay', [this.other.address, g2o, '0x']),
                },
              ],
              '<proposal description>',
            );

            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline();
            await this.helper.queue();
            await this.helper.waitForEta();

            await expect(this.helper.execute()).to.changeEtherBalances(
              [this.timelock_1, this.mock, this.other],
              [-t2g, t2g - g2o, g2o],
            );
          });
          it('is payable and can transfer eth to EOA - Proposal type 1', async function () {
            const t2g = 128n; // timelock to governor
            const g2o = 100n; // governor to eoa (other)

            this.helper.setProposal(
              [
                {
                  target: this.mock.target,
                  value: t2g,
                  data: this.mock.interface.encodeFunctionData('relay', [this.other.address, g2o, '0x']),
                  propType: '1',
                },
              ],
              '<proposal description>',
            );

            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline();
            await this.helper.queue();
            await this.helper.waitForEta();

            await expect(this.helper.execute()).to.changeEtherBalances(
              [this.timelock_2, this.mock, this.other],
              [-t2g, t2g - g2o, g2o],
            );
          });

          it('protected against other proposers', async function () {
            const call = [
              this.mock,
              0n,
              this.mock.interface.encodeFunctionData('relay', [ethers.ZeroAddress, 0n, '0x']),
              ethers.ZeroHash,
              ethers.ZeroHash,
            ];

            await this.timelock_1.connect(this.owner).schedule(...call, delay);

            await time.increaseBy.timestamp(delay);

            // Error bubbled up from Governor
            await expect(this.timelock_1.connect(this.owner).execute(...call)).to.be.revertedWithPanic(
              PANIC_CODES.POP_ON_EMPTY_ARRAY,
            );
          });
        });

        describe('updateExecutor', function () {
          beforeEach(async function () {
            this.newTimelock = await ethers.deployContract('TimelockController', [
              delay,
              [this.mock],
              [this.mock],
              ethers.ZeroAddress,
            ]);
            this.newExecutor = await ethers.deployContract('ProposalExecutor', [[this.newTimelock.target]]);
          });

          it('is protected', async function () {
            await expect(this.mock.connect(this.owner).updateExecutor(this.newExecutor))
              .to.be.revertedWithCustomError(this.mock, 'GovernorOnlyExecutor')
              .withArgs(this.owner);
          });

          it('can be executed through governance to', async function () {
            this.helper.setProposal(
              [
                {
                  target: this.mock.target,
                  data: this.mock.interface.encodeFunctionData('updateExecutor', [this.newExecutor.target]),
                },
              ],
              '<proposal description>',
            );

            await this.helper.propose();
            await this.helper.waitForSnapshot();
            await this.helper.connect(this.voter1).vote({ support: VoteType.For });
            await this.helper.waitForDeadline();
            await this.helper.queue();
            await this.helper.waitForEta();

            await expect(this.helper.execute())
              .to.emit(this.mock, 'ExecutorChange')
              .withArgs(this.executor, this.newExecutor);

            expect(await this.mock.timelock()).to.equal(this.newExecutor);
          });
        });

        describe('on safe receive', function () {
          describe('ERC721', function () {
            const tokenId = 1n;

            beforeEach(async function () {
              this.token = await ethers.deployContract('$ERC721', ['Non Fungible Token', 'NFT']);
              await this.token.$_mint(this.owner, tokenId);
            });

            it("can't receive an ERC721 safeTransfer", async function () {
              await expect(
                this.token.connect(this.owner).safeTransferFrom(this.owner, this.mock, tokenId),
              ).to.be.revertedWithCustomError(this.mock, 'GovernorDisabledDeposit');
            });
          });

          describe('ERC1155', function () {
            const tokenIds = {
              1: 1000n,
              2: 2000n,
              3: 3000n,
            };

            beforeEach(async function () {
              this.token = await ethers.deployContract('$ERC1155', ['https://token-cdn-domain/{id}.json']);
              await this.token.$_mintBatch(this.owner, Object.keys(tokenIds), Object.values(tokenIds), '0x');
            });

            it("can't receive ERC1155 safeTransfer", async function () {
              await expect(
                this.token.connect(this.owner).safeTransferFrom(
                  this.owner,
                  this.mock,
                  ...Object.entries(tokenIds)[0], // id + amount
                  '0x',
                ),
              ).to.be.revertedWithCustomError(this.mock, 'GovernorDisabledDeposit');
            });

            it("can't receive ERC1155 safeBatchTransfer", async function () {
              await expect(
                this.token
                  .connect(this.owner)
                  .safeBatchTransferFrom(this.owner, this.mock, Object.keys(tokenIds), Object.values(tokenIds), '0x'),
              ).to.be.revertedWithCustomError(this.mock, 'GovernorDisabledDeposit');
            });
          });
        });
      });

      it('clear queue of pending governor calls', async function () {
        this.helper.setProposal(
          [
            {
              target: this.mock.target,
              data: this.mock.interface.encodeFunctionData('nonGovernanceFunction'),
            },
          ],
          '<proposal description>',
        );

        await this.helper.propose();
        await this.helper.waitForSnapshot();
        await this.helper.connect(this.voter1).vote({ support: VoteType.For });
        await this.helper.waitForDeadline();
        await this.helper.queue();
        await this.helper.waitForEta();
        await this.helper.execute();

        // This path clears _governanceCall as part of the afterExecute call,
        // but we have not way to check that the cleanup actually happened other
        // then coverage reports.
      });
    });
  }
});
