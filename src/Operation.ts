import * as Yup from 'yup';
import Document from './lib/Document';
import Encoder from './Encoder';
import Logger from './lib/Logger';
import Multihash from './Multihash';
import { applyPatch } from 'fast-json-patch';
import { DidDocument } from '@decentralized-identity/did-common-typescript';
import { getProtocol } from './Protocol';
import { ResolvedTransaction } from './Transaction';

/**
 * Sidetree operation types.
 */
enum OperationType {
  Create,
  Update,
  Delete,
  Recover
}

/**
 * Defines operation request data structure for basic type safety checks.
 */
interface IOperation {
  header: {
    operation: string,
    kid: string,
    proofOfWork: object
  };
  payload: string;
  signature: string;
}

/**
 * A class that represents a Sidetree operation.
 * The primary purphose of this class is to provide an abstraction to the underlying JSON data structure.
 *
 * NOTE: Design choices of:
 * 1. No subclassing of specific operations. The intention here is to keep the hierarchy flat, as most properties are common.
 * 2. Factory method to hide constructor in case subclassing becomes useful in the future. Most often a good practice anyway.
 */
class Operation {
  /** The logical blockchain time that this opeartion was anchored on the blockchain */
  public readonly transactionTime?: number;
  /** The transaction number of the transaction this operation was batched within. */
  public readonly transactionNumber?: number;
  /** The index this operation was assigned to in the batch. */
  public readonly operationIndex?: number;
  /** The hash of the batch file this operation belongs to */
  public readonly batchFileHash?: string;

  /** The original request buffer sent by the requester. */
  public readonly operationBuffer: Buffer;
  /**
   * The incremental number of each update made to the same DID Document.
   * Delete and Recover operations don't have this number.
   * TODO: need to revisit: 1. Should this really be called update number? What happens to this number.
   */
  public readonly operationNumber?: Number;
  /** The encoded operation payload. */
  public readonly encodedPayload: string;
  /** The DID of the DID document to be updated. */
  public readonly did?: string;
  /** The type of operation. */
  public readonly type: OperationType;
  /** The hash of the previous operation - undefined for DID create operation */
  public readonly previousOperationHash?: string;
  /** ID of the key used to sign this operation. */
  public readonly signingKeyId: string;
  /** Signature of this operation. */
  public readonly signature: string;
  /** Proof-of-work of this operation. */
  public proofOfWork: any; // TODO: to be implemented.

  /** DID document given in the operation, only applicable to create and recovery operations, undefined otherwise. */
  public readonly didDocument?: DidDocument;

  /** Patch to the DID Document, only applicable to update operations, undefined otherwise. */
  public readonly patch?: any[];

  /**
   * Constructs an Operation if the operation buffer passes schema validation, throws error otherwise.
   * @param resolvedTransaction The transaction operation this opeartion was batched within.
   *                            If given, operationIndex must be given else error will be thrown.
   *                            The transactoinTimeHash is ignored by the constructor.
   * @param operationIndex The operation index this operation was assigned to in the batch.
   *                       If given, resolvedTransaction must be given else error will be thrown.
   */
  private constructor (
    operationBuffer: Buffer,
    resolvedTransaction?: ResolvedTransaction,
    operationIndex?: number) {
    // resolvedTransaction and operationIndex must both be defined or undefined at the same time.
    if (!((resolvedTransaction === undefined && operationIndex === undefined) ||
          (resolvedTransaction !== undefined && operationIndex !== undefined))) {
      throw new Error('Param transactionNumber and operationIndex must both be defined or undefined.');
    }

    // Properties of an operation in a resolved transaction.
    this.transactionTime = resolvedTransaction ? resolvedTransaction.transactionTime : undefined;
    this.transactionNumber = resolvedTransaction ? resolvedTransaction.transactionNumber : undefined;
    this.batchFileHash = resolvedTransaction ? resolvedTransaction.batchFileHash : undefined;

    this.operationIndex = operationIndex;
    this.operationBuffer = operationBuffer;

    // Parse request buffer into a JS object.
    const operationJson = operationBuffer.toString();
    const operation = JSON.parse(operationJson);

    // Ensure that the operation is well-formed.
    const wellFormedResult = Operation.isWellFormed(operation);
    if (wellFormedResult === undefined) {
      throw new Error(`Operation buffer is not well-formed: ${operationJson}`);
    }

    // Initialize common operation properties.
    const [operationType, decodedPayload] = wellFormedResult;
    this.type = operationType;
    this.signingKeyId = operation.header.kid;
    this.proofOfWork = operation.header.proofOfWork;
    this.encodedPayload = operation.payload;
    this.signature = operation.signature;

    // Initialize operation specific properties.
    switch (this.type) {
      case OperationType.Create:
        this.operationNumber = 0;
        break;
      case OperationType.Update:
        this.operationNumber = decodedPayload.operationNumber;
        this.did = decodedPayload.did;
        this.previousOperationHash = decodedPayload.previousOperationHash;
        this.patch = decodedPayload.patch;
        break;
      case OperationType.Delete:
        this.did = decodedPayload.did;
        break;
      default:
        throw new Error(`Not implemented operation type ${this.type}.`);
    }
  }

  /**
   * Creates an Operation if the given operation buffer passes schema validation, throws error otherwise.
   * @param resolvedTransaction The transaction operation was batched within. If given, operationIndex must be given else error will be thrown.
   * @param operationIndex The operation index this operation was assigned to in the batch.
   *                       If given, resolvedTransaction must be given else error will be thrown.
   */
  public static create (
    operationBuffer: Buffer,
    resolvedTransaction?: ResolvedTransaction,
    operationIndex?: number): Operation {
    return new Operation(operationBuffer, resolvedTransaction, operationIndex);
  }

  /**
   * Applies the given JSON Patch to the specified DID Document.
   * NOTE: a new instance of the DidDocument is returned, the original instance is not modified.
   * @returns The resultant DID Document.
   */
  public static applyJsonPatchToDidDocument (didDocument: DidDocument, jsonPatch: any[]): DidDocument {
    const validatePatchOperation = true;
    const mutateOriginalContent = false;
    const updatedDidDocument = applyPatch(didDocument, jsonPatch, validatePatchOperation, mutateOriginalContent);
    // TODO: Need to add extensive tests to make sure validation follows protocol behavior.

    return updatedDidDocument.newDocument;
  }

  /**
   * Gets the operation type given an operation object.
   */
  private static getOperationType (operation: IOperation): OperationType {
    switch (operation.header.operation) {
      case 'create':
        return OperationType.Create;
      case 'update':
        return OperationType.Update;
      case 'delete':
        return OperationType.Delete;
      case 'recover':
        return OperationType.Recover;
      default:
        throw new Error(`Unknown operation type: ${operation.header.operation}`);
    }
  }

  /**
   * Verifies if the given operation object is well-formed.
   * NOTE: Well-formed validation does not include signature verification.
   * @returns [operation type, decoded payload json object] if given operation is well-formed, returns undefined otherwise.
   */
  private static isWellFormed (operation: IOperation): [OperationType, any] | undefined {
    try {
      const commonSchema = Yup.object({
        header: Yup.object({
          operation: Yup.string().required().oneOf(['create', 'update', 'delete', 'recover']),
          kid: Yup.string().required(),
          proofOfWork: Yup.object().required()
        }).required(),
        payload: Yup.string().required(),
        signature: Yup.string().required()
      });

      const passedCommonSchemaValidation = commonSchema.isValidSync(operation);
      if (!passedCommonSchemaValidation) {
        Logger.info(`Operation failed common schema validation: ${JSON.stringify(operation)}`);
        return undefined;
      }

      // Get the operation type.
      const operationType = Operation.getOperationType(operation);

      // Decode the encoded operation string.
      const decodedPayloadJson = Encoder.decodeAsString(operation.payload);
      const decodedPayload = JSON.parse(decodedPayloadJson);

      // Verify operation specific payload schema.
      let payloadSchemaIsValid;
      switch (operationType) {
        case OperationType.Create:
          payloadSchemaIsValid = Document.isObjectValidOriginalDocument(decodedPayload);
          break;
        default:
          payloadSchemaIsValid = true;
      }

      if (!payloadSchemaIsValid) {
        Logger.info(`${OperationType[operationType]} payload failed schema validation: ${decodedPayloadJson}`);
        return undefined;
      }

      return [operationType, decodedPayload];
    } catch (error) {
      Logger.info(`Operation failed schema validation: ${JSON.stringify(operation)}`);
      return undefined;
    }
  }
}

/**
 * Get a cryptographic hash of the operation.
 * In the case of a Create operation, the hash is calculated against the initial encoded create payload (DID Document),
 * for all other cases, the hash is calculated against the entire opeartion buffer.
 */
function getOperationHash (operation: Operation): string {

  if (operation.transactionTime === undefined) {
    throw new Error(`Transaction time not given but needed for DID generation.`);
  }

  // Get the protocol version according to the transaction time to decide on the hashing algorithm used for the DID.
  const protocol = getProtocol(operation.transactionTime);

  let contentBuffer;
  if (operation.type === OperationType.Create) {
    contentBuffer = Buffer.from(operation.encodedPayload);
  } else {
    contentBuffer = operation.operationBuffer;
  }

  const multihash = Multihash.hash(contentBuffer, protocol.hashAlgorithmInMultihashCode);
  const encodedMultihash = Encoder.encode(multihash);
  return encodedMultihash;
}

export { getOperationHash, IOperation, OperationType, Operation };
