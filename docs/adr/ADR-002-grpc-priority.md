# ADR-002: gRPC para el servicio de Prioridad

**Fecha:** 2025-06  
**Estado:** Aceptado

## Contexto

El sistema requiere que al menos un par de microservicios se comunique vía gRPC con contrato `.proto` definido.

## Decisión

El microservicio de **Priority** expone un servidor gRPC en el puerto 50051 con el contrato `priority.proto`. Los servicios que necesiten clasificar una alerta pueden llamarlo directamente (sin pasar por Redis).

## Alternativas consideradas

| Alternativa | Pros | Contras |
|---|---|---|
| **gRPC** ✓ | Contrato fuerte, tipado, eficiente | Curva de aprendizaje, proto files |
| REST/JSON | Simple, familiar | Sin schema enforcement, más verboso |
| GraphQL | Flexible queries | Innecesariamente complejo para este caso |

## Justificación

- gRPC usa Protocol Buffers: mensajes más pequeños y rápidos que JSON
- El contrato `.proto` documenta explícitamente la interfaz entre servicios
- Cumple el requisito obligatorio del examen
- La clasificación de prioridad es un caso ideal: input/output bien definidos

## Contrato gRPC (priority.proto)

```protobuf
service PriorityService {
  rpc ClassifyAlert (AlertRequest) returns (AlertResponse);
}
```

## Consecuencias

- Los clientes gRPC deben tener el mismo archivo `.proto`
- Se mantiene también el procesador de cola Redis para el flujo principal (desacoplado)
